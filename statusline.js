// statusline：記錄 5 小時用量給 hook 用、補抓撞限額事件、顯示狀態列
'use strict';
const path = require('path');
const L = require('./lib');
const { handleHit } = require('./relay');

function main() {
  const input = L.readStdin();
  const cfg = L.loadConfig();
  L.ensureDirs();
  L.writeJson(path.join(L.DIRS.debug, 'statusline.json'), input);

  const parts = [];
  if (input.model?.display_name) parts.push(input.model.display_name);

  const five = L.parseFiveHour(input.rate_limits);
  if (five) {
    L.writeJson(L.USAGE_FILE, { five_hour: five, updatedAt: Date.now() });
    parts.push(`5h ${Math.round(five.used)}%（${L.hhmm(five.resetsAt)} 重置）`);
  }

  const sid = input.session_id;
  const transcript = input.transcript_path;
  if (sid && transcript) {
    const records = L.tailRecords(transcript, 256 * 1024);
    const ctx = L.lastContextTokens(records);
    if (ctx) parts.push(`ctx ${L.kTok(ctx)}`);

    const sess = L.loadSession(sid);
    sess.transcriptPath = transcript;
    sess.cwd = sess.cwd || input.workspace?.current_dir || input.cwd;
    // StopFailure 沒觸發時的保底：狀態列看到撞限額訊息就自己處理
    const hit = cfg.enabled && L.findLimitHit(records);
    if (hit) handleHit(sess, hit, cfg, 'statusline');
    const cur = L.loadSession(sid);
    if (cur.hit?.mode === 'relay') {
      const job = L.loadJob(cur.hit.jobId);
      if (job?.status === 'waiting') parts.push(`relay：${L.hhmm((job.resetsAt || 0) + cfg.launchDelaySec)} 開新 session 接手`);
      else if (job) parts.push(`relay：${job.status}`);
    } else if (five && cur.triggeredFor === five.resetsAt) {
      parts.push(cur.handoffWrittenFor === five.resetsAt ? 'relay：交接已存' : 'relay：等模型寫交接');
    }
  }
  process.stdout.write(parts.join(' · '));
}

try {
  main();
} catch (e) {
  L.log(`statusline 錯誤：${e.stack || e}`);
}
