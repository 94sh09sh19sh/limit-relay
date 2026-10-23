// 在新的終端機分頁裡啟動 Claude Code，並用環境變數告訴 SessionStart hook 要注入哪份交接
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');

const PROMPT = '請依照 SessionStart 注入的 limit-relay 交接內容，接續上一個 session 因用量限額中斷的工作。已完成的部分不要重做，先確認現況再繼續。';

function findClaude() {
  const names = ['claude.exe', 'claude.cmd', 'claude'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(L.os.homedir(), '.local', 'bin', 'claude.exe');
}

const job = L.loadJob(process.argv[2]);
if (!job) {
  console.error(`limit-relay：找不到工作 ${process.argv[2]}`);
  process.exit(1);
}

const exe = findClaude();
const args = job.permissionMode && job.permissionMode !== 'default' ? ['--permission-mode', job.permissionMode, PROMPT] : [PROMPT];
console.log(`limit-relay：接手 ${job.cwd}\n交接檔：${job.handoffPath}\n`);
// 測試用：只印出要執行的指令，不真的啟動 claude
if (job.dryRun) {
  console.log(`[dryRun] ${exe} ${JSON.stringify(args)}
LIMIT_RELAY_JOB=${job.id}`);
  L.log(`[${job.id}] dryRun 啟動成功`);
  setTimeout(() => process.exit(0), 8000);
  return;
}
const child = spawn(exe, args, {
  cwd: job.cwd,
  stdio: 'inherit',
  shell: exe.endsWith('.cmd'),
  env: { ...process.env, LIMIT_RELAY_JOB: job.id },
});
child.on('error', (e) => {
  L.log(`[${job.id}] 啟動 claude 失敗：${e.message}`);
  console.error(`啟動 claude 失敗：${e.message}`);
});
child.on('exit', (code) => process.exit(code ?? 0));
