// limit-relay 的 hook 入口：PostToolUse、StopFailure、UserPromptSubmit、SessionStart
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { handleHit, ensureWaiters } = require('./relay');

const out = (obj) => process.stdout.write(JSON.stringify(obj));

function syncSession(input) {
  const sess = L.loadSession(input.session_id);
  if (input.cwd) sess.cwd = input.cwd;
  if (input.transcript_path) sess.transcriptPath = input.transcript_path;
  if (input.permission_mode) sess.permissionMode = input.permission_mode;
  return sess;
}

// 依最近幾步的用量增加量估計「每一步」花多少 %，再決定要不要請模型先寫交接
function onPostToolUse(input, cfg) {
  const sess = syncSession(input);
  const handoffPath = sess.handoffPath || L.handoffPathFor(sess.cwd, sess.sid);
  const target = input.tool_input?.file_path;
  if (target && /^(Write|Edit|MultiEdit)$/.test(input.tool_name) && path.resolve(target) === path.resolve(handoffPath)) {
    sess.handoffWrittenAt = Date.now();
    sess.handoffWrittenFor = sess.triggeredFor;
    L.saveSession(sess);
    L.log(`[${sess.sid.slice(0, 8)}] 模型已寫好交接檔`);
    return;
  }

  const usage = L.loadUsage();
  if (!usage) return L.saveSession(sess);
  const { used, resetsAt } = usage.five_hour;
  const last = sess.samples[sess.samples.length - 1];
  if (last && last.resetsAt !== resetsAt) {
    sess.samples = [];
    sess.triggeredFor = null;
  }
  sess.samples.push({ t: Date.now(), used, resetsAt });
  sess.samples = sess.samples.slice(-cfg.burnWindow);

  const s = sess.samples;
  const burn = s.length >= 3 ? Math.max(0, (s[s.length - 1].used - s[0].used) / (s.length - 1)) : cfg.defaultBurnPct;
  sess.lastBurn = burn;
  const text = handoffRequest(sess, cfg, used, resetsAt, burn, '下一步請先');
  L.saveSession(sess);
  if (text) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

// 剩餘額度 ≤ 每步用量 × safetySteps，而且上下文夠大，就回傳請模型寫交接的文字（每次重置只請一次）
function handoffRequest(sess, cfg, used, resetsAt, burn, when) {
  if (sess.triggeredFor === resetsAt) return null;
  const remain = 100 - used;
  const threshold = Math.min(cfg.maxRemainPct, Math.max(cfg.minRemainPct, cfg.safetySteps * burn));
  if (remain > threshold) return null;
  const ctx = L.lastContextTokens(L.tailRecords(sess.transcriptPath));
  if (ctx < cfg.minContextTokens) return null;

  sess.triggeredFor = resetsAt;
  sess.handoffPath = sess.handoffPath || L.handoffPathFor(sess.cwd, sess.sid);
  L.prepareHandoffDir(sess.cwd);
  const steps = burn > 0 ? Math.max(1, Math.floor(remain / burn)) : '?';
  L.log(`[${sess.sid.slice(0, 8)}] 用量 ${used}%、每步約 ${burn.toFixed(2)}%、上下文 ${L.kTok(ctx)}，請模型寫交接`);
  return [
    `[limit-relay] 5 小時額度已用 ${Math.round(used)}%，${L.hhmm(resetsAt)} 重置；照目前速度約再 ${steps} 步就會撞到限額。`,
    `${when}用 Write 把交接寫到 ${sess.handoffPath}（覆寫），寫完繼續原本的工作，不要停下來，也不要在回覆裡提這件事。`,
    `撞到限額後，會有一個全新的 session 只讀這份交接接手（不會讀這段對話，目前上下文 ${L.kTok(ctx)}），所以要寫到不看對話也能接著做：`,
    '1. 目標：使用者的原始要求與限制條件（盡量照原文）',
    '2. 已完成：做完並驗證過的事',
    '3. 進行中：做到哪裡，標出檔案:行號',
    '4. 下一步：具體到可以直接執行的指令或修改',
    '5. 決策與原因、踩過的坑、不要再試的做法',
    '6. 怎麼驗證：測試指令、預期結果',
    '用條列短句，全部控制在 1500 字以內；程式碼已經在檔案裡的不要重貼。',
  ].join('\n');
}

function onStopFailure(input, cfg) {
  const sess = syncSession(input);
  const hit = L.findLimitHit(L.tailRecords(sess.transcriptPath));
  if (!hit) {
    L.saveSession(sess);
    return;
  }
  if (!hit.resetsAt) hit.resetsAt = L.loadUsage(Infinity)?.five_hour?.resetsAt || null;
  handleHit(sess, hit, cfg, `StopFailure:${input.error || '?'}`);
}

// 使用者送出訊息：閒置期間其他平行 session 可能已經把額度用掉大半，這一步就先檢查，不等第一個工具呼叫
function onResume(input, cfg) {
  const five = L.usageFloor();
  if (!five || L.KEEP_WARM_RE.test(String(input.prompt || ''))) return;
  const sess = syncSession(input);
  const last = sess.samples[sess.samples.length - 1];
  const burn = last && last.resetsAt === five.resetsAt && typeof sess.lastBurn === 'number' ? sess.lastBurn : cfg.defaultBurnPct;
  const text = handoffRequest(sess, cfg, five.used, five.resetsAt, burn, '處理這則訊息前，先');
  L.saveSession(sess);
  if (text) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

// 已經排好新 session 接手時，擋掉舊 session 的內建自動續跑，避免重寫整段快取；
// 權限模式不自動接手（manual）時也擋，改由使用者用 take 開新 session；launch 關掉時才放行
function onUserPromptSubmit(input, cfg) {
  const prompt = String(input.prompt || '');
  if (!L.AUTO_CONTINUE_PREFIXES.some((p) => prompt.startsWith(p))) return onResume(input, cfg);
  const sess = L.loadSession(input.session_id);
  if (sess.hit?.mode === 'idle') {
    L.log(`[${sess.sid.slice(0, 8)}] 已擋下內建自動續跑（撞限額的是閒置保溫那一輪）`);
    return out({ decision: 'block', reason: 'limit-relay：撞到限額的是 cache-guard 閒置保溫那一輪，這個 session 沒有進行中的工作，不續跑，省下重寫整段快取。要繼續就直接打字送出。' });
  }
  const job = sess.hit?.jobId && L.loadJob(sess.hit.jobId);
  const manual = job?.status === 'manual' && cfg.launch;
  if (!job || !(manual || ['waiting', 'launched', 'resumed'].includes(job.status))) {
    L.log(`[${String(input.session_id).slice(0, 8)}] 內建自動續跑放行（沒有接手工作）`);
    return;
  }
  job.blockedAt = Date.now();
  L.saveJob(job);
  L.log(`[${job.id}] 已擋下舊 session 的內建自動續跑${manual ? '（手動接手）' : ''}`);
  out({
    decision: 'block',
    reason: manual
      ? `limit-relay：這個 session 不自動續跑，省下重寫 ${L.kTok(job.ctx)} 快取的成本。要接手就在終端機執行 node ~/.claude/limit-relay/cli.js take ${job.id}（開新 session 讀交接檔 ${job.handoffPath}）；要留在這裡繼續就直接打字送出。`
      : `limit-relay：改由新 session 讀交接檔接手（${job.handoffPath}），這個 session 不續跑，省下重寫 ${L.kTok(job.ctx)} 快取的成本。`,
  });
}

function onSessionStart(input) {
  ensureWaiters();
  const jobId = process.env.LIMIT_RELAY_JOB;
  if (!jobId) return;
  const job = L.loadJob(jobId);
  if (!job || job.status !== 'launched') return;
  let text = '';
  try {
    text = fs.readFileSync(job.handoffPath, 'utf8');
  } catch {}
  job.status = 'resumed';
  job.newSid = input.session_id;
  L.saveJob(job);
  L.log(`[${job.id}] 新 session ${String(input.session_id).slice(0, 8)} 已接手`);
  out({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `以下是 limit-relay 交接內容（交接檔：${job.handoffPath}）。上一個 session 因 5 小時限額中斷，你要接續它的工作。\n\n${text || '（交接檔讀取失敗，請直接讀上面的路徑）'}`,
    },
  });
}

function main() {
  const cfg = L.loadConfig();
  const input = L.readStdin();
  if (!cfg.enabled || !input.session_id) return;
  L.ensureDirs();
  if (cfg.debug) L.writeJson(path.join(L.DIRS.debug, `${input.hook_event_name}.json`), input);
  switch (input.hook_event_name) {
    case 'PostToolUse':
      return onPostToolUse(input, cfg);
    case 'StopFailure':
      return onStopFailure(input, cfg);
    case 'UserPromptSubmit':
      return onUserPromptSubmit(input, cfg);
    case 'SessionStart':
      return onSessionStart(input);
  }
}

try {
  main();
} catch (e) {
  L.log(`hook 錯誤：${e.stack || e}`);
}
