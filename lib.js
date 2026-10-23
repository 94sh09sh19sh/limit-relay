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

// 最近一次真正送到 API 的請求有多大，就是續跑時要重寫的快取量
function lastContextTokens(records) {
  const r = records.find(isRealAssistant);
  return r ? contextTokens(r.message.usage) : 0;
}

// 找最近一筆「撞到限額」的合成訊息
function findLimitHit(records) {
  for (const r of records) {
    if (isRealAssistant(r)) return null;
    if (r.type === 'assistant' && r.apiError === 'usage_limit_reached') {
      const info = r.apiErrorParams?.rate_limit_info || r.quotaLimits || {};
      return { resetsAt: info.resetsAt || null, at: Date.parse(r.timestamp) || Date.now(), type: info.rateLimitType || 'unknown' };
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
  sessionFile, jobFile, loadSession, saveSession, loadJob, saveJob, listJobs,
  parseFiveHour, loadUsage, tailRecords, isRealAssistant, contextTokens, lastContextTokens, findLimitHit,
  hhmm, kTok, handoffPathFor, prepareHandoffDir, pidAlive, os,
};
