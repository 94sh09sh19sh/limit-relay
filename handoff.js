// 從逐字稿機械式擷取交接內容，不呼叫模型、不花 token
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isRealAssistant } = require('./lib');

const clip = (s, n) => {
  s = String(s || '').trim();
  return s.length > n ? `${s.slice(0, n)}…（截斷）` : s;
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// 排除工具結果、系統注入、斜線指令等，只留下使用者真正打的字
function isHumanPrompt(r) {
  if (r.type !== 'user' || r.isMeta || r.isSidechain || r.isCompactSummary) return false;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  return !/^<(command-|local-command|system-reminder|task-notification|bash-)/.test(t) && !t.startsWith('Your claude.ai usage');
}

function readAll(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function toolBrief(b) {
  const i = b.input || {};
  const arg = i.command || i.file_path || i.notebook_path || i.pattern || i.url || i.query || i.description || '';
  return `${b.name}：${clip(String(arg).replace(/\s+/g, ' '), 160)}`;
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// sinceMs：只擷取這個時間之後的進度（模型已寫過交接檔時使用）
function extract(transcriptPath, cwd, sinceMs = 0) {
  const all = readAll(transcriptPath);
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].type === 'system' && all[i].subtype === 'compact_boundary') {
      start = i;
      break;
    }
  }
  const recs = all.slice(start).filter((r) => !sinceMs || (Date.parse(r.timestamp) || 0) >= sinceMs);
  const summary = all.slice(start).find((r) => r.isCompactSummary);

  const prompts = all.filter(isHumanPrompt);
  const firstPrompt = prompts[0];
  const recentPrompts = recs.filter(isHumanPrompt).slice(-5);

  const files = new Map();
  const tools = [];
  const errors = new Set();
  const texts = [];
  for (const r of recs) {
    const c = r.message?.content;
    if (!Array.isArray(c)) continue;
    if (isRealAssistant(r)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) texts.push(b.text);
        if (b.type !== 'tool_use') continue;
        tools.push(b);
        const f = b.input?.file_path || b.input?.notebook_path;
        if (f && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) {
          files.delete(f);
          files.set(f, b.name);
        }
      }
    } else if (r.type === 'user') {
      for (const b of c) {
        if (b.type === 'tool_result' && b.is_error) errors.add(b.tool_use_id);
      }
    }
  }

  const out = [];
  if (!sinceMs && firstPrompt) out.push('## 原始需求（session 第一則訊息）', clip(textOf(firstPrompt.message.content), 2500), '');
  if (!sinceMs && summary) out.push('## 先前壓縮摘要', clip(textOf(summary.message.content), 8000), '');
  if (recentPrompts.length) {
    out.push('## 最近的使用者訊息');
    for (const p of recentPrompts) out.push(`- ${clip(textOf(p.message.content).replace(/\s*\n\s*/g, ' / '), 1200)}`);
    out.push('');
  }
  if (files.size) {
    out.push('## 改過的檔案（舊到新）');
    for (const [f, how] of [...files].slice(-30)) out.push(`- ${f}（${how}）`);
    out.push('');
  }
  if (texts.length) {
    out.push('## 中斷前最後幾段回覆');
    for (const t of texts.slice(-4)) out.push(clip(t, 1500), '');
  }
  if (tools.length) {
    out.push('## 中斷前最後幾個工具呼叫');
    for (const b of tools.slice(-10)) out.push(`- ${errors.has(b.id) ? '【失敗】' : ''}${toolBrief(b)}`);
    out.push('');
  }
  const status = git(cwd, ['status', '--short']);
  if (status) {
    const lines = status.split('\n');
    out.push('## git status', '```', ...lines.slice(0, 40), ...(lines.length > 40 ? [`…另有 ${lines.length - 40} 行`] : []), '```', '');
  }
  return out.join('\n');
}

// 組出最後交給新 session 的交接檔：模型寫的交接（若有）＋之後的機械式進度
function finalize({ transcriptPath, cwd, handoffPath, llmWrittenAt, hitAt, resetsAt }) {
  const head = [
    '# limit-relay 交接',
    '',
    `- 上一個 session 在 ${new Date(hitAt).toLocaleString('zh-TW', { hour12: false })} 撞到 5 小時限額，限額 ${resetsAt ? new Date(resetsAt * 1000).toLocaleString('zh-TW', { hour12: false }) : '?'} 重置。`,
    `- 原逐字稿：${transcriptPath}（需要細節時可以用 Grep 查，不要整份讀進來）`,
    '- 已完成的部分不要重做；先用 git status、讀相關檔案確認現況再繼續。',
    '',
  ];
  let body;
  const llm = llmWrittenAt && fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '';
  if (llm.trim()) {
    const delta = extract(transcriptPath, cwd, llmWrittenAt);
    body = ['## 模型寫的交接', llm.replace(/^# .*\n/, '').trim(), '', '# 寫完交接後到中斷前的進度（自動擷取）', delta || '（沒有新進度）'];
  } else {
    body = ['（模型來不及寫交接，以下全部從逐字稿自動擷取）', '', extract(transcriptPath, cwd)];
  }
  const text = [...head, ...body].join('\n');
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
  fs.writeFileSync(handoffPath, text);
  return text;
}

module.exports = { extract, finalize };

if (require.main === module) {
  const [transcript, cwd] = process.argv.slice(2);
  if (!transcript) {
    console.error('用法：node handoff.js <逐字稿.jsonl> [專案目錄]');
    process.exit(1);
  }
  process.stdout.write(extract(transcript, cwd || process.cwd()));
}
