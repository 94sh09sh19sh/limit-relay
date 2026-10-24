// 撞到限額後的接手流程：決定要不要接手、產生交接檔、排程啟動新 session
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');
const { finalize } = require('./handoff');

function spawnWaiter(jobId) {
  const child = spawn(process.execPath, [path.join(L.ROOT, 'waiter.js'), jobId], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// 同一個 session 同一次重置只處理一次；StopFailure 和 statusline 都可能呼叫，重複的由這裡擋掉
function handleHit(sess, hit, cfg, source) {
  if (!sess.transcriptPath || !sess.cwd) return null;
  const key = hit.resetsAt || Math.floor(hit.at / 1000);
  // 閒置保溫撞到的限額不算數：之後使用者回來又撞到（同一個重置時間）要照常處理
  if (sess.hit && sess.hit.key === key && (sess.hit.mode !== 'idle' || sess.hit.at === hit.at)) return null;

  if (hit.idle) {
    sess.hit = { key, resetsAt: hit.resetsAt, at: hit.at, mode: 'idle', source };
    L.saveSession(sess);
    L.log(`[${sess.sid.slice(0, 8)}] cache-guard 保溫那一輪撞到限額，session 原本閒置，不接手也不續跑（來源 ${source}）`);
    return null;
  }

  const records = L.tailRecords(sess.transcriptPath);
  const ctx = L.lastContextTokens(records);
  sess.hit = { key, resetsAt: hit.resetsAt, at: hit.at, ctx, source };

  if (ctx < cfg.minContextTokens) {
    sess.hit.mode = 'builtin';
    L.saveSession(sess);
    L.log(`[${sess.sid.slice(0, 8)}] 撞到限額，上下文只有 ${L.kTok(ctx)}，交給內建續跑`);
    return null;
  }

  const handoffPath = sess.handoffPath || L.handoffPathFor(sess.cwd, sess.sid);
  L.prepareHandoffDir(sess.cwd);
  const llmWrittenAt = sess.handoffWrittenFor === sess.triggeredFor ? sess.handoffWrittenAt : 0;
  finalize({ transcriptPath: sess.transcriptPath, cwd: sess.cwd, handoffPath, llmWrittenAt, hitAt: hit.at, resetsAt: hit.resetsAt });

  const launch = cfg.launch && cfg.launchModes.includes(sess.permissionMode);
  const job = {
    id: `${sess.sid.slice(0, 8)}-${key}`,
    sid: sess.sid,
    cwd: sess.cwd,
    transcriptPath: sess.transcriptPath,
    handoffPath,
    permissionMode: sess.permissionMode || 'default',
    hitAt: hit.at,
    resetsAt: hit.resetsAt,
    ctx,
    llmHandoff: Boolean(llmWrittenAt),
    status: launch ? 'waiting' : 'manual',
    dryRun: Boolean(cfg.dryRun),
    createdAt: Date.now(),
  };
  L.saveJob(job);
  sess.hit.mode = launch ? 'relay' : 'manual';
  sess.hit.jobId = job.id;
  L.saveSession(sess);

  if (launch) {
    job.waiterPid = spawnWaiter(job.id);
    L.saveJob(job);
  }
  L.log(`[${sess.sid.slice(0, 8)}] 撞到限額（來源 ${source}），上下文 ${L.kTok(ctx)}，交接檔 ${handoffPath}，${launch ? `${L.hhmm(hit.resetsAt)} 重置後自動開新 session` : `權限模式 ${sess.permissionMode}，不自動啟動`}`);
  return job;
}

// 電腦重開或等待用的背景程式被關掉時，把還在等待的工作重新掛回去
function ensureWaiters() {
  for (const job of L.listJobs()) {
    if (job.status !== 'waiting' || L.pidAlive(job.waiterPid)) continue;
    if (Date.now() - job.createdAt > 24 * 3600 * 1000) {
      job.status = 'expired';
      L.saveJob(job);
      continue;
    }
    job.waiterPid = spawnWaiter(job.id);
    L.saveJob(job);
    L.log(`[${job.id}] 重新掛上等待用的背景程式`);
  }
}

module.exports = { handleHit, ensureWaiters, spawnWaiter };
