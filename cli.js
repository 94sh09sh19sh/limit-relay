// limit-relay 管理指令：status、log、cancel、take、report、handoff
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const [cmd = 'status', arg] = process.argv.slice(2);

function status() {
  const cfg = L.loadConfig();
  const u = L.readJson(L.USAGE_FILE);
  console.log(`啟用：${cfg.enabled ? '是' : '否'}`);
  if (u) console.log(`5 小時用量：${Math.round(u.five_hour.used)}%，${L.hhmm(u.five_hour.resetsAt)} 重置（${Math.round((Date.now() - u.updatedAt) / 60000)} 分鐘前更新）`);
  else console.log('5 小時用量：還沒收到（開一個互動 session 讓狀態列跑過一次）');
  const jobs = L.listJobs().sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  if (!jobs.length) return console.log('接手工作：無');
  console.log('接手工作（新到舊）：');
  for (const j of jobs) {
    console.log(`- ${j.id}｜${j.status}｜撞限額 ${new Date(j.hitAt).toLocaleString('zh-TW', { hour12: false })}｜重置 ${L.hhmm(j.resetsAt)}｜上下文 ${L.kTok(j.ctx)}｜模型交接 ${j.llmHandoff ? '有' : '無'}${j.blockedAt ? '｜已擋內建續跑' : ''}｜${j.cwd}`);
  }
}

function cancel() {
  let n = 0;
  for (const j of L.listJobs()) {
    if (j.status !== 'waiting' || (arg !== 'all' && j.id !== arg)) continue;
    j.status = 'cancelled';
    L.saveJob(j);
    n++;
  }
  console.log(`已取消 ${n} 個等待中的工作`);
}

// 手動接手：權限模式不自動啟動的工作，在目前的終端機開新 session 並注入交接
function take() {
  const job = L.loadJob(arg);
  if (!job) return console.log(`找不到工作 ${arg}；用 status 看工作 id`);
  if (!['manual', 'cancelled'].includes(job.status)) return console.log(`工作 ${job.id} 的狀態是 ${job.status}，不能再接手`);
  job.status = 'launched';
  job.launchedAt = Date.now();
  job.via = 'take';
  L.saveJob(job);
  L.log(`[${job.id}] 使用者手動接手`);
  const r = require('child_process').spawnSync(process.execPath, [path.join(L.ROOT, 'launch.js'), job.id], { stdio: 'inherit' });
  process.exitCode = r.status ?? 0;
}

// 統計每次限額重置後第一個請求重寫了多少快取，用來比較使用前後的差異
function report() {
  const root = path.join(L.os.homedir(), '.claude', 'projects');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []));
  const rows = [];
  for (const f of walk(root)) {
    const recs = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const relay = r.type === 'user' && !r.isSidechain && /limit-relay 交接內容/.test(JSON.stringify(r.message?.content ?? r.content ?? ''));
      const hit = r.type === 'assistant' && r.apiError === 'usage_limit_reached';
      if (!relay && !hit) continue;
      const next = recs.slice(i + 1).find(L.isRealAssistant);
      if (!next) continue;
      const u = next.message.usage;
      rows.push({ t: next.timestamp, kind: relay ? '接手' : '續跑', write: u.cache_creation_input_tokens || 0, read: u.cache_read_input_tokens || 0, file: path.basename(f).slice(0, 8) });
    }
  }
  const seen = new Set();
  const uniq = rows.filter((r) => !seen.has(r.t + r.file) && seen.add(r.t + r.file)).sort((a, b) => a.t.localeCompare(b.t));
  for (const r of uniq) console.log(`${r.t.slice(0, 16)}｜${r.kind}｜快取寫入 ${L.kTok(r.write)}｜快取讀取 ${L.kTok(r.read)}｜${r.file}`);
  for (const kind of ['續跑', '接手']) {
    const xs = uniq.filter((r) => r.kind === kind);
    if (xs.length) console.log(`${kind}：${xs.length} 次，平均快取寫入 ${L.kTok(xs.reduce((s, r) => s + r.write, 0) / xs.length)}`);
  }
}

switch (cmd) {
  case 'status':
    status();
    break;
  case 'log':
    console.log(fs.existsSync(L.LOG_FILE) ? fs.readFileSync(L.LOG_FILE, 'utf8').split('\n').slice(-(Number(arg) || 30)).join('\n') : '（沒有紀錄）');
    break;
  case 'cancel':
    cancel();
    break;
  case 'report':
    report();
    break;
  case 'take':
    take();
    break;
  case 'handoff':
    process.stdout.write(require('./handoff').extract(arg, process.cwd()));
    break;
  default:
    console.log('用法：node cli.js [status|log [行數]|cancel <工作 id|all>|take <工作 id>|report|handoff <逐字稿.jsonl>]');
}
