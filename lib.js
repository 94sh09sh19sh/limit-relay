// limit-relay 共用函式：路徑、設定、狀態檔、記錄、逐字稿讀取
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const STATE = path.join(ROOT, 'state');
const DIRS = {
  sessions: path.join(STATE, 'sessions'),
  jobs: path.join(STATE, 'jobs'),
  debug: path.join(STATE, 'debug'),
};
const USAGE_FILE = path.join(STATE, 'usage.json');
const LOG_FILE = path.join(STATE, 'relay.log');

// 內建自動續跑送出的兩種訊息開頭
const AUTO_CONTINUE_PREFIXES = [
  'Your claude.ai usage limit has reset.',
  'Your claude.ai usage is available again',
];

const DEFAULT_CONFIG = {
  enabled: true,
  minContextTokens: 80000,
  safetySteps: 4,
  minRemainPct: 2,
  maxRemainPct: 25,
  burnWindow: 12,
  defaultBurnPct: 1,
  launch: true,
  launchModes: ['auto'],
  launchDelaySec: 150,
  terminal: 'wt',
  // Stop 時還有背景工作或排程，就在背景盯用量，快撞到限額時叫醒 session 寫交接
  watchIdle: true,
  watchPollSec: 30,
  // 要比 deploy.json 裡 Stop hook 的 timeout 短，自己先結束，不被 Claude Code 砍掉
  watchMaxSec: 17940,
  // Stop 後等多久才記下逐字稿大小當基準（Claude Code 收尾還會寫幾筆紀錄）
  watchBaselineSec: 20,
  // 快取已過期時要不要照樣叫醒（要整段重寫）
  watchWakeCold: false,
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免多個 hook 同時寫入時讀到半個檔案
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  // LIMIT_RELAY_CONFIG_JSON 只給測試用，可以臨時覆寫設定
  let env = {};
  try {
    env = JSON.parse(process.env.LIMIT_RELAY_CONFIG_JSON || '{}');
  } catch {}
  // config.json 是 repo 的預設值；config.local.json 是本機個人設定，部署不會覆蓋
  return { ...DEFAULT_CONFIG, ...readJson(path.join(ROOT, 'config.json'), {}), ...readJson(path.join(ROOT, 'config.local.json'), {}), ...env };
}

function log(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const sessionFile = (sid) => path.join(DIRS.sessions, `${sid}.json`);
// 背景盯用量的擁有者另外存，避免和 session 檔同時寫入時互相蓋掉
const watchFile = (sid) => path.join(DIRS.sessions, `${sid}.watch.json`);

const fileSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
};
const jobFile = (id) => path.join(DIRS.jobs, `${id}.json`);

function loadSession(sid) {
  return readJson(sessionFile(sid), { sid, samples: [] });
}

function saveSession(s) {
  s.updatedAt = Date.now();
  writeJson(sessionFile(s.sid), s);
}

function loadJob(id) {
  return readJson(jobFile(id));
}

function saveJob(job) {
  job.updatedAt = Date.now();
  writeJson(jobFile(job.id), job);
}

function listJobs() {
  try {
    return fs.readdirSync(DIRS.jobs).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(DIRS.jobs, f))).filter(Boolean);
  } catch {
    return [];
  }
}

// 從 statusline 輸入取出 5 小時額度；欄位名稱各版本可能不同，所以多試幾種
function parseFiveHour(rl) {
  const w = rl && (rl.five_hour || rl.fiveHour);
  if (!w) return null;
  let used = w.used_percentage ?? w.usedPercentage ?? w.percent ?? w.utilization;
  if (typeof used !== 'number') return null;
  if (w.used_percentage === undefined && w.percent === undefined && used <= 1) used *= 100;
  let resetsAt = w.resets_at ?? w.resetsAt;
  if (typeof resetsAt === 'string') resetsAt = Math.floor(Date.parse(resetsAt) / 1000);
  if (typeof resetsAt === 'number' && resetsAt > 1e12) resetsAt = Math.floor(resetsAt / 1000);
  return { used, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

function loadUsage(maxAgeMs = 15 * 60 * 1000) {
  const u = readJson(USAGE_FILE);
  if (!u || !u.five_hour || Date.now() - u.updatedAt > maxAgeMs) return null;
  return u;
}

// 5 小時用量的下限：用量檔只在有 session 活動時更新，但同一個視窗內用量只增不減，舊值仍是有效下限；視窗已重置就從 0 算
function usageFloor() {
  const f = readJson(USAGE_FILE)?.five_hour;
  if (!f || typeof f.used !== 'number') return null;
  if (f.resetsAt && Date.now() >= f.resetsAt * 1000) return { ...f, used: 0 };
  return f;
}

// 讀逐字稿最後一段，由新到舊回傳解析後的紀錄
function tailRecords(file, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        out.push(JSON.parse(lines[i]));
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isRealAssistant = (r) => r.type === 'assistant' && !r.isSidechain && r.message?.usage && r.message.model !== '<synthetic>';

function contextTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// 最後一次主對話請求的快取還沒過期（1 小時或 5 分鐘，看最後一次寫入的是哪種），留 2 分鐘餘裕
function cacheWarm(records) {
  const r = records.find(isRealAssistant);
  if (!r) return false;
  const cc = r.message.usage.cache_creation || {};
  const ttl = cc.ephemeral_5m_input_tokens > 0 && !(cc.ephemeral_1h_input_tokens > 0) ? 5 * 60e3 : 60 * 60e3;
  return Date.now() - Date.parse(r.timestamp) < ttl - 2 * 60e3;
}

// 最近一次真正送到 API 的請求有多大，就是續跑時要重寫的快取量
function lastContextTokens(records) {
  const r = records.find(isRealAssistant);
  return r ? contextTokens(r.message.usage) : 0;
}

// cache-guard 喚醒閒置 session 時送進來的訊息
const KEEP_WARM_RE = /cache-guard (自動保溫|喚醒測試)（不是使用者訊息）/;

function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
}

// 觸發這一輪的是不是 cache-guard 保溫：往前找第一筆不是工具結果的使用者紀錄
function isKeepWarmTurn(older) {
  const u = older.find((r) => r.type === 'user' && !r.isSidechain && !(Array.isArray(r.message?.content) && r.message.content.some((b) => b.type === 'tool_result')));
  return Boolean(u && KEEP_WARM_RE.test(textOf(u.message?.content)));
}

// 找最近一筆「撞到限額」的合成訊息；idle 代表撞到的是閒置保溫那一輪，沒有進行中的工作
function findLimitHit(records) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (isRealAssistant(r)) return null;
    if (r.type === 'assistant' && r.apiError === 'usage_limit_reached') {
      const info = r.apiErrorParams?.rate_limit_info || r.quotaLimits || {};
      return { resetsAt: info.resetsAt || null, at: Date.parse(r.timestamp) || Date.now(), type: info.rateLimitType || 'unknown', idle: isKeepWarmTurn(records.slice(i + 1)) };
    }
  }
  return null;
}

function hhmm(epochSec) {
  if (!epochSec) return '?';
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function handoffPathFor(cwd, sid) {
  return path.join(cwd, '.limit-relay', `handoff-${sid.slice(0, 8)}.md`);
}

// 交接檔放在專案底下；若是 git 專案就寫進 .git/info/exclude，不會被提交
function prepareHandoffDir(cwd) {
  const dir = path.join(cwd, '.limit-relay');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const ex = path.join(cwd, '.git', 'info', 'exclude');
    if (fs.existsSync(path.dirname(ex))) {
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.limit-relay/')) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}.limit-relay/\n`);
    }
  } catch {}
  return dir;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = {
  ROOT, STATE, DIRS, USAGE_FILE, LOG_FILE, AUTO_CONTINUE_PREFIXES, DEFAULT_CONFIG,
  ensureDirs, readJson, writeJson, loadConfig, log, readStdin,
  sessionFile, watchFile, fileSize, jobFile, loadSession, saveSession, loadJob, saveJob, listJobs,
  parseFiveHour, loadUsage, usageFloor, tailRecords, isRealAssistant, contextTokens, lastContextTokens, cacheWarm, KEEP_WARM_RE, findLimitHit,
  hhmm, kTok, handoffPathFor, prepareHandoffDir, pidAlive, os,
};
