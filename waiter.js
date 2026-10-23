// 背景等待：限額重置後確認舊 session 沒有自己續跑，再開新的終端機分頁啟動 Claude Code
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');

const jobId = process.argv[2];
const POLL_MS = 20 * 1000;

// 撞限額之後舊 session 若又有真正的 API 回應，代表內建續跑沒被擋下或使用者自己接手了
function oldSessionResumed(job) {
  return L.tailRecords(job.transcriptPath, 1024 * 1024).some((r) => L.isRealAssistant(r) && Date.parse(r.timestamp) > job.hitAt);
}

// WindowsApps 底下的 wt.exe 是應用程式別名，existsSync 會回 false，要用 lstat 判斷
function isAlias(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function launch(job, cfg) {
  const args = [path.join(L.ROOT, 'launch.js'), job.id];
  const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  if (cfg.terminal === 'wt' && isAlias(wt)) {
    spawn(wt, ['-w', '0', 'new-tab', '--title', `limit-relay ${path.basename(job.cwd)}`, '-d', job.cwd, process.execPath, ...args], { detached: true, stdio: 'ignore' }).unref();
    return 'wt';
  }
  // 沒有 Windows Terminal 時改開一般的 cmd 視窗
  const q = (x) => `"${x}"`;
  const cmdline = `/c start "limit-relay" /d ${q(job.cwd)} ${q(process.execPath)} ${args.map(q).join(' ')}`;
  spawn('cmd.exe', [cmdline], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
  return 'cmd';
}

// 新 session 遇到沒信任過的資料夾會跳出確認框，需要人按；自己或任一上層資料夾被信任過才自動啟動
function isTrusted(cwd) {
  const projects = L.readJson(path.join(L.os.homedir(), '.claude.json'), {})?.projects || {};
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const trusted = new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted).map(([k]) => norm(k)));
  let dir = norm(cwd);
  for (;;) {
    if (trusted.has(dir)) return true;
    const up = path.posix.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function tick() {
  const job = L.loadJob(jobId);
  if (!job || job.status !== 'waiting') return process.exit(0);
  if (job.waiterPid !== process.pid && L.pidAlive(job.waiterPid)) return process.exit(0);
  const cfg = L.loadConfig();
  const target = ((job.resetsAt || Math.floor(job.hitAt / 1000) + 5 * 3600) + cfg.launchDelaySec) * 1000;
  if (Date.now() < target) return setTimeout(tick, Math.min(POLL_MS, target - Date.now() + 50));

  if (!cfg.enabled) {
    job.status = 'cancelled';
    L.saveJob(job);
    L.log(`[${job.id}] 工具已停用，取消啟動`);
    return process.exit(0);
  }
  if (oldSessionResumed(job)) {
    job.status = 'skipped';
    L.saveJob(job);
    L.log(`[${job.id}] 舊 session 已經自己續跑（內建續跑沒被擋下或你手動接手），不再開新 session`);
    return process.exit(0);
  }
  if (!fs.existsSync(job.cwd)) {
    job.status = 'failed';
    L.saveJob(job);
    L.log(`[${job.id}] 專案目錄不存在：${job.cwd}`);
    return process.exit(0);
  }
  if (!isTrusted(job.cwd)) {
    job.status = 'untrusted';
    L.saveJob(job);
    L.log(`[${job.id}] ${job.cwd} 沒有被信任過，新 session 會卡在信任確認框，所以不自動啟動；交接檔在 ${job.handoffPath}`);
    return process.exit(0);
  }
  job.status = 'launched';
  job.launchedAt = Date.now();
  L.saveJob(job);
  const via = launch(job, cfg);
  L.log(`[${job.id}] 已用 ${via} 開新 session 接手（${job.cwd}）`);
  process.exit(0);
}

if (!jobId) process.exit(1);
setTimeout(tick, 1000);
