#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const ARCHIVE_DIR = path.join(CODEX_HOME, 'archived_sessions');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const PORT = Number(process.env.PORT || 8787);

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sqliteJson(sql) {
  const output = cp.execFileSync('sqlite3', ['-json', STATE_DB, sql], { encoding: 'utf8' });
  return JSON.parse(output || '[]');
}

function sqliteRun(sql) {
  cp.execFileSync('sqlite3', [STATE_DB, sql], { encoding: 'utf8' });
}

function sqlQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function idFromArchiveName(name) {
  const match = name.match(/(019e[0-9a-f-]+)\.jsonl$/);
  return match ? match[1] : '';
}

function rolloutTimeFromName(name) {
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]}` : '';
}

function localTime(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function compactTitle(row, id) {
  const raw = String(row?.title || row?.first_user_message || row?.preview || '').trim();
  if (!raw) return `(未找到标题：${id})`;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.startsWith('Automation:')) {
    const match = oneLine.match(/Last run: (never|[0-9TZ:.\-]+)/);
    return match ? `Automation: EyeFlow 对话轮换监控 (${match[1]})` : 'Automation: EyeFlow 对话轮换监控';
  }
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function getThreadRow(id) {
  const rows = sqliteJson(`
    select id,title,created_at,updated_at,archived_at,rollout_path,first_user_message,preview,archived,cwd
    from threads
    where id = ${sqlQuote(id)}
  `);
  return rows[0] || null;
}

function getArchives() {
  const rows = sqliteJson(`
    select id,title,created_at,updated_at,archived_at,rollout_path,first_user_message,preview,archived
    from threads
  `);
  const byId = new Map(rows.map(row => [row.id, row]));
  const files = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter(name => name.endsWith('.jsonl'))
    : [];

  const fileEntries = files.map(name => {
    const id = idFromArchiveName(name);
    const file = path.join(ARCHIVE_DIR, name);
    const stat = fs.statSync(file);
    const row = byId.get(id);
    return {
      id,
      title: compactTitle(row, id),
      rolloutTime: rolloutTimeFromName(name),
      updatedAt: localTime(row?.updated_at),
      archivedAt: localTime(row?.archived_at),
      sizeKB: Math.round(stat.size / 1024),
      file,
      fileName: name,
      exists: true,
      inDatabase: Boolean(row),
      archivedFlag: Boolean(row?.archived),
    };
  });

  const archivedRowsWithoutFile = rows
    .filter(row => row.archived && !fileEntries.some(entry => entry.id === row.id))
    .map(row => ({
      id: row.id,
      title: compactTitle(row, row.id),
      rolloutTime: '',
      updatedAt: localTime(row.updated_at),
      archivedAt: localTime(row.archived_at),
      sizeKB: 0,
      file: row.rollout_path,
      fileName: path.basename(row.rollout_path || ''),
      exists: false,
      inDatabase: true,
      archivedFlag: true,
    }));

  return [...fileEntries, ...archivedRowsWithoutFile]
    .sort((a, b) => (b.rolloutTime || b.updatedAt).localeCompare(a.rolloutTime || a.updatedAt));
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      return part.text || part.input_text || part.output_text || '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function archivePathFor(id, row) {
  const entry = getArchives().find(item => item.id === id && item.exists);
  if (entry) return entry.file;
  if (row?.rollout_path && fs.existsSync(row.rollout_path)) return row.rollout_path;
  return '';
}

function archiveDetails(id) {
  if (!id || !/^019e[0-9a-f-]+$/.test(id)) throw new Error('Invalid archive id');
  const row = getThreadRow(id);
  const file = archivePathFor(id, row);
  const messages = [];
  let meta = {};

  if (file) {
    const lines = fs.readFileSync(file, 'utf8').split(/\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type === 'session_meta') {
        meta = record.payload || {};
        continue;
      }
      const payload = record.payload || {};
      if (record.type !== 'response_item' || payload.type !== 'message') continue;
      if (!['user', 'assistant'].includes(payload.role)) continue;
      const messageText = textFromMessageContent(payload.content);
      if (!messageText) continue;
      if (messageText.trim().startsWith('<environment_context>')) continue;
      messages.push({
        role: payload.role,
        text: messageText.length > 6000 ? `${messageText.slice(0, 6000)}...` : messageText,
      });
      if (messages.length >= 80) break;
    }
  }

  const cwd = row?.cwd || meta.cwd || '';
  return {
    id,
    title: compactTitle(row, id),
    cwd,
    projectExists: Boolean(cwd && fs.existsSync(cwd)),
    rolloutPath: file || row?.rollout_path || '',
    firstUserMessage: row?.first_user_message || row?.preview || '',
    updatedAt: localTime(row?.updated_at),
    archivedAt: localTime(row?.archived_at),
    messages,
  };
}

function openProject(id) {
  const details = archiveDetails(id);
  if (!details.cwd) throw new Error('This archive has no project folder recorded');
  if (!fs.existsSync(details.cwd)) throw new Error('Project folder no longer exists');
  const opener = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'explorer'
      : 'xdg-open';
  cp.execFileSync(opener, [details.cwd], { stdio: 'ignore' });
  return { opened: true, cwd: details.cwd };
}

function removeFromSessionIndex(id) {
  if (!fs.existsSync(SESSION_INDEX)) return false;
  const original = fs.readFileSync(SESSION_INDEX, 'utf8');
  const next = original
    .split(/\n/)
    .filter(line => !line.trim() || !line.includes(id))
    .join('\n')
    .replace(/\n*$/, '\n');
  if (next !== original) {
    fs.writeFileSync(SESSION_INDEX, next, 'utf8');
    return true;
  }
  return false;
}

function deleteArchive(id, mode) {
  if (!id || !/^019e[0-9a-f-]+$/.test(id)) throw new Error('Invalid archive id');
  if (!['file', 'index'].includes(mode)) throw new Error('Invalid delete mode');

  const entries = getArchives().filter(entry => entry.id === id);
  if (!entries.length) throw new Error('Archive was not found');

  const result = {
    id,
    mode,
    removedFiles: [],
    removedDatabaseRow: false,
    removedSessionIndexLines: false,
  };

  const filesToRemove = entries
    .map(entry => entry.exists ? entry.file : '')
    .filter(Boolean);

  for (const file of filesToRemove) {
    if (path.dirname(file) !== ARCHIVE_DIR) throw new Error(`Refusing to delete outside archive dir: ${file}`);
    fs.unlinkSync(file);
    result.removedFiles.push(file);
  }

  if (mode === 'index') {
    sqliteRun(`delete from threads where id = ${sqlQuote(id)};`);
    result.removedDatabaseRow = true;
    result.removedSessionIndexLines = removeFromSessionIndex(id);
  }

  return result;
}

const page = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex 归档管理器</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f4;
      --panel: #ffffff;
      --panel-soft: #fafaf8;
      --text: #202124;
      --muted: #6d737a;
      --line: #dfe3df;
      --line-strong: #ccd3ce;
      --accent: #176b87;
      --accent-soft: #e6f3f6;
      --danger: #b42318;
      --danger-bg: #fff1ef;
      --warning: #8a5a00;
      --warning-bg: #fff7df;
      --ok: #1b7f4b;
      --ok-bg: #e8f6ee;
      --shadow: 0 18px 44px rgba(24, 35, 42, .08);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    header {
      background: linear-gradient(180deg, #ffffff 0%, #f5f6f4 100%);
      border-bottom: 1px solid var(--line);
    }
    .shell {
      max-width: 1240px;
      margin: 0 auto;
      padding: 18px 24px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
    }
    .brand {
      display: grid;
      gap: 7px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      font-weight: 720;
      letter-spacing: 0;
    }
    .subtitle {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      max-width: 680px;
      overflow-wrap: anywhere;
    }
    .status {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
      color: var(--muted);
    }
    .pill.ok {
      border-color: #b8dfc8;
      background: var(--ok-bg);
      color: var(--ok);
    }
    .mini-button {
      min-height: 28px;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--accent);
      border-color: #b8d8e3;
      background: var(--accent-soft);
    }
    .stats {
      display: flex;
      gap: 8px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .stat {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, .9);
      border-radius: 999px;
      padding: 6px 10px;
      display: inline-flex;
      gap: 7px;
      align-items: baseline;
    }
    .stat-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 0;
    }
    .stat-value {
      font-size: 14px;
      font-weight: 760;
      line-height: 1;
    }
    main {
      max-width: 1240px;
      margin: 0 auto;
      padding: 0 24px 44px;
    }
    .workspace {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 150px auto auto;
      gap: 12px;
      align-items: center;
      padding: 14px;
      background: var(--panel-soft);
      border-bottom: 1px solid var(--line);
    }
    input, select, button {
      height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      font: inherit;
      letter-spacing: 0;
    }
    input:focus, select:focus, button:focus-visible {
      outline: 3px solid rgba(23, 107, 135, .16);
      border-color: var(--accent);
    }
    input {
      padding: 0 12px;
      min-width: 0;
    }
    select, button {
      padding: 0 10px;
    }
    select {
      min-width: 136px;
      padding: 0 36px 0 12px;
      appearance: none;
      background-image:
        linear-gradient(45deg, transparent 50%, #2f343a 50%),
        linear-gradient(135deg, #2f343a 50%, transparent 50%);
      background-position:
        calc(100% - 20px) 16px,
        calc(100% - 14px) 16px;
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
    }
    button {
      cursor: pointer;
      font-weight: 620;
      transition: background-color .16s ease, border-color .16s ease, color .16s ease, transform .16s ease;
    }
    button:hover:not(:disabled) {
      transform: translateY(-1px);
    }
    button.primary {
      color: #fff;
      background: var(--accent);
      border-color: var(--accent);
    }
    button.danger {
      color: var(--danger);
      background: var(--danger-bg);
      border-color: #ffcdc7;
    }
    button.ghost {
      color: var(--accent);
      border-color: #b8d8e3;
      background: var(--accent-soft);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: .48;
      transform: none;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      min-height: 18px;
      align-self: center;
      white-space: nowrap;
    }
    .table-wrap {
      overflow: auto;
    }
    .archive-list {
      display: grid;
      gap: 0;
    }
    .archive-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 200px 230px;
      gap: 16px;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      transition: background-color .12s ease;
    }
    .archive-row:hover {
      background: #fbfcfa;
    }
    .archive-row:last-child {
      border-bottom: 0;
    }
    .row-main {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .row-topline {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .row-title {
      font-size: 14px;
      line-height: 1.4;
      font-weight: 680;
      overflow-wrap: anywhere;
    }
    .row-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .row-side {
      display: grid;
      gap: 6px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .row-side strong {
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
    }
    .row-file {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .row-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 13px 14px;
      vertical-align: middle;
      text-align: left;
      font-size: 13px;
    }
    th {
      background: #f0f2ef;
      color: #4f565c;
      font-weight: 650;
      white-space: nowrap;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tbody tr {
      transition: background-color .12s ease;
    }
    tbody tr:hover {
      background: #fbfcfa;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .title-cell {
      display: grid;
      gap: 8px;
      max-width: 520px;
    }
    .title {
      font-size: 14px;
      line-height: 1.38;
      font-weight: 640;
      overflow-wrap: anywhere;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #f8f8f6;
      font-size: 12px;
      line-height: 1;
    }
    .badge.auto {
      color: #285f73;
      background: var(--accent-soft);
      border-color: #b8d8e3;
    }
    .badge.missing {
      color: var(--warning);
      background: var(--warning-bg);
      border-color: #f2d58d;
    }
    .path {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      max-width: 300px;
      overflow-wrap: anywhere;
    }
    .missing {
      color: var(--danger);
      font-weight: 620;
    }
    .time {
      color: #34383d;
      white-space: nowrap;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .empty {
      padding: 36px 20px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }
    .toast {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 4;
      max-width: min(420px, calc(100vw - 36px));
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid #b8dfc8;
      background: var(--ok-bg);
      color: var(--ok);
      box-shadow: var(--shadow);
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
      font-size: 13px;
    }
    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
    dialog {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0;
      width: min(560px, calc(100vw - 30px));
      box-shadow: 0 24px 60px rgba(0, 0, 0, .18);
    }
    dialog.detail-dialog {
      width: min(920px, calc(100vw - 30px));
    }
    dialog::backdrop {
      background: rgba(0,0,0,.24);
    }
    .modal {
      padding: 20px;
      display: grid;
      gap: 14px;
    }
    .modal h2 {
      margin: 0;
      font-size: 18px;
    }
    .modal p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .modal strong {
      color: var(--text);
    }
    .delete-summary {
      display: grid;
      gap: 10px;
    }
    .delete-title {
      font-size: 14px;
      color: var(--muted);
      line-height: 1.45;
    }
    .delete-name {
      display: block;
      margin-top: 4px;
      color: var(--text);
      font-size: 16px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .delete-note {
      border: 1px solid var(--line);
      background: var(--panel-soft);
      border-radius: 8px;
      padding: 12px;
      display: grid;
      gap: 8px;
      color: #3f464c;
      font-size: 14px;
      line-height: 1.48;
    }
    .delete-note div {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 8px;
      align-items: start;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .detail-body {
      display: grid;
      gap: 14px;
      max-height: min(68vh, 720px);
      overflow: auto;
      padding-right: 4px;
    }
    .detail-meta {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr);
      gap: 8px 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-soft);
      font-size: 13px;
      line-height: 1.45;
    }
    .detail-meta dt {
      color: var(--muted);
      font-weight: 650;
    }
    .detail-meta dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .transcript {
      display: grid;
      gap: 10px;
    }
    .message {
      display: grid;
      gap: 6px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
    }
    .message.user {
      border-color: #cde0e7;
      background: #f4fbfd;
    }
    .message-role {
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
    }
    .message-text {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
      line-height: 1.55;
      color: var(--text);
    }
    .muted-note {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 900px) {
      .topbar {
        display: grid;
      }
      .status {
        justify-content: flex-start;
      }
      .controls {
        grid-template-columns: 1fr 1fr;
      }
      .archive-row {
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
      }
      .row-actions {
        justify-content: flex-start;
      }
    }
    @media (max-width: 760px) {
      .shell {
        padding: 14px 16px;
      }
      main {
        margin-top: 0;
        padding: 0 16px 36px;
      }
      .controls {
        grid-template-columns: 1fr;
      }
      .status {
        gap: 6px;
      }
      .archive-row {
        padding: 13px;
      }
      .row-actions button {
        flex: 1 1 112px;
      }
    }
    body.sidebar {
      background: var(--panel);
    }
    body.sidebar header {
      background: var(--panel);
    }
    body.sidebar .shell {
      padding: 12px;
    }
    body.sidebar .topbar {
      display: grid;
      gap: 10px;
    }
    body.sidebar h1 {
      font-size: 17px;
    }
    body.sidebar .subtitle {
      display: none;
    }
    body.sidebar .status {
      justify-content: flex-start;
      gap: 6px;
    }
    body.sidebar .pill.ok,
    body.sidebar #lastLoaded {
      display: none;
    }
    body.sidebar main {
      margin: 0;
      padding: 0;
    }
    body.sidebar .workspace {
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-radius: 0;
      box-shadow: none;
    }
    body.sidebar .controls {
      grid-template-columns: 1fr;
      gap: 8px;
      padding: 10px 12px;
    }
    body.sidebar .archive-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 9px;
      padding: 12px;
    }
    body.sidebar .row-side {
      display: none;
    }
    body.sidebar .row-actions {
      justify-content: flex-start;
    }
    body.sidebar .row-actions button {
      flex: 1 1 96px;
      height: 34px;
      padding: 0 8px;
    }
    body.sidebar .row-meta {
      gap: 7px;
    }
  </style>
</head>
<body>
  <header>
    <div class="shell">
      <div class="topbar">
        <div class="brand">
          <h1>Codex 归档管理器</h1>
          <div class="subtitle" id="archivePath">本地归档</div>
        </div>
      </div>
    </div>
  </header>
  <main>
    <section class="workspace" aria-label="归档列表">
      <div class="controls">
        <label class="sr-only" for="q">搜索</label>
        <input id="q" placeholder="搜索标题、时间或文件名">
        <label class="sr-only" for="filter">筛选</label>
        <select id="filter">
          <option value="all">全部归档</option>
          <option value="normal">普通对话</option>
          <option value="automation">自动化记录</option>
          <option value="missing">索引残留</option>
        </select>
        <button id="refresh" class="primary">刷新</button>
        <span id="meta" class="meta">0 / 0</span>
      </div>
      <div id="rows" class="archive-list"></div>
    </section>
  </main>

  <dialog id="confirm">
    <div class="modal">
      <h2 id="confirmTitle">确认删除</h2>
      <p id="confirmBody"></p>
      <div class="modal-actions">
        <button id="cancel">取消</button>
        <button id="confirmDelete" class="danger">确认删除</button>
      </div>
    </div>
  </dialog>
  <dialog id="details" class="detail-dialog">
    <div class="modal">
      <h2 id="detailsTitle">回看归档</h2>
      <div class="detail-body">
        <dl class="detail-meta" id="detailsMeta"></dl>
        <div class="transcript" id="detailsMessages"></div>
      </div>
      <div class="modal-actions">
        <button id="openProject" class="ghost">打开项目文件夹</button>
        <button id="closeDetails" class="primary">关闭</button>
      </div>
    </div>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    if (new URLSearchParams(location.search).get('mode') === 'sidebar') {
      document.body.classList.add('sidebar');
    }

    let archives = [];
    let pendingDelete = null;
    const rows = document.querySelector('#rows');
    const q = document.querySelector('#q');
    const filter = document.querySelector('#filter');
    const meta = document.querySelector('#meta');
    const dialog = document.querySelector('#confirm');
    const confirmBody = document.querySelector('#confirmBody');
    const confirmDelete = document.querySelector('#confirmDelete');
    const toast = document.querySelector('#toast');
    const archivePath = document.querySelector('#archivePath');
    const detailsDialog = document.querySelector('#details');
    const detailsTitle = document.querySelector('#detailsTitle');
    const detailsMeta = document.querySelector('#detailsMeta');
    const detailsMessages = document.querySelector('#detailsMessages');
    const openProject = document.querySelector('#openProject');
    const closeDetails = document.querySelector('#closeDetails');
    let currentDetailsId = null;

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function archiveKind(item) {
      if (!item.exists) return '索引残留';
      if (item.title.startsWith('Automation:')) return '自动化';
      return '对话';
    }

    function showToast(message) {
      toast.textContent = message;
      toast.classList.add('show');
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
    }

    function visibleItems() {
      const term = q.value.trim().toLowerCase();
      return archives.filter(item => {
        if (filter.value === 'normal' && item.title.startsWith('Automation:')) return false;
        if (filter.value === 'automation' && !item.title.startsWith('Automation:')) return false;
        if (filter.value === 'missing' && item.exists) return false;
        if (!term) return true;
        return [item.title, item.rolloutTime, item.archivedAt, item.fileName, item.id]
          .join(' ')
          .toLowerCase()
          .includes(term);
      });
    }

    function render() {
      const items = visibleItems();
      meta.textContent = items.length + ' / ' + archives.length;
      if (!items.length) {
        rows.innerHTML = '<div class="empty">没有匹配的归档</div>';
        return;
      }
      rows.innerHTML = items.map(item => {
        const size = item.exists ? item.sizeKB + ' KB' : '<span class="missing">文件已不在归档夹</span>';
        const kind = archiveKind(item);
        const badgeClass = kind === '自动化' ? 'badge auto' : kind === '索引残留' ? 'badge missing' : 'badge';
        return ''
          + '<article class="archive-row">'
          + '<div class="row-main">'
          + '<div class="row-topline"><span class="' + badgeClass + '">' + escapeHtml(kind) + '</span><span class="row-title">' + escapeHtml(item.title) + '</span></div>'
          + '<div class="row-meta"><span>会话 ' + escapeHtml(item.rolloutTime || item.updatedAt || '') + '</span><span>归档 ' + escapeHtml(item.archivedAt || '未记录') + '</span><span>' + size + '</span></div>'
          + '</div>'
          + '<div class="row-side"><strong>记录文件</strong><span class="row-file">' + escapeHtml(item.fileName || item.file) + '</span></div>'
          + '<div class="row-actions">'
          + '<button data-action="view" data-id="' + escapeHtml(item.id) + '" class="ghost">回看</button>'
          + '<button data-action="index" data-id="' + escapeHtml(item.id) + '" class="danger">彻底移除</button>'
          + '</div>'
          + '</article>';
      }).join('');
    }

    async function load() {
      meta.textContent = '读取中';
      const res = await fetch('/api/archives', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      archives = data.archives;
      archivePath.textContent = data.archiveDir || '本地归档';
      render();
    }

    function askDelete(item) {
      pendingDelete = { id: item.id, mode: 'index' };
      const confirmTitle = document.querySelector('#confirmTitle');
      confirmTitle.textContent = '从归档里彻底移除？';
      confirmDelete.textContent = '确认彻底移除';
      const notes = [
        ['✓', '只处理 Codex 的归档对话记录，不会改动项目目录里的任何文件。'],
        ['✓', '会删除这份归档对话日志文件。'],
        ['✓', '会把这条记录也从 Codex 的归档列表里移除。']
      ];
      confirmBody.innerHTML = ''
        + '<span class="delete-summary">'
        + '<span class="delete-title">归档名称<span class="delete-name">' + escapeHtml(item.title) + '</span></span>'
        + '<span class="delete-note">'
        + notes.map(note => '<div><strong>' + escapeHtml(note[0]) + '</strong><span>' + escapeHtml(note[1]) + '</span></div>').join('')
        + '</span>'
        + '</span>';
      dialog.showModal();
    }

    async function showDetails(item) {
      currentDetailsId = item.id;
      detailsTitle.textContent = '读取中';
      detailsMeta.innerHTML = '';
      detailsMessages.innerHTML = '<div class="empty">正在读取归档内容</div>';
      openProject.disabled = true;
      detailsDialog.showModal();
      try {
        const res = await fetch('/api/archives/' + item.id + '/details', { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        detailsTitle.textContent = data.title || '回看归档';
        openProject.disabled = !data.projectExists;
        openProject.textContent = data.projectExists ? '打开项目文件夹' : '项目文件夹不存在';
        detailsMeta.innerHTML = ''
          + '<dt>项目路径</dt><dd>' + escapeHtml(data.cwd || '未记录') + '</dd>'
          + '<dt>归档时间</dt><dd>' + escapeHtml(data.archivedAt || '未记录') + '</dd>'
          + '<dt>记录文件</dt><dd>' + escapeHtml(data.rolloutPath || '未找到') + '</dd>';
        if (!data.messages.length) {
          detailsMessages.innerHTML = '<div class="empty">没有可预览的用户/助手消息</div>';
          return;
        }
        detailsMessages.innerHTML = data.messages.map(message => {
          const role = message.role === 'user' ? '你' : 'Codex';
          const className = message.role === 'user' ? 'message user' : 'message';
          return ''
            + '<article class="' + className + '">'
            + '<div class="message-role">' + role + '</div>'
            + '<pre class="message-text">' + escapeHtml(message.text) + '</pre>'
            + '</article>';
        }).join('');
      } catch (err) {
        detailsTitle.textContent = '读取失败';
        detailsMessages.innerHTML = '<div class="empty">' + escapeHtml(err.message || String(err)) + '</div>';
      }
    }

    async function openCurrentProject() {
      if (!currentDetailsId) return;
      openProject.disabled = true;
      try {
        const res = await fetch('/api/archives/' + currentDetailsId + '/open-project', { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        showToast('已打开项目文件夹');
      } catch (err) {
        alert(err.message || String(err));
      } finally {
        openProject.disabled = false;
      }
    }

    async function doDelete() {
      if (!pendingDelete) return;
      confirmDelete.disabled = true;
      confirmDelete.textContent = '删除中';
      try {
        const res = await fetch('/api/archives/' + pendingDelete.id, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: pendingDelete.mode }),
        });
        if (!res.ok) throw new Error(await res.text());
        dialog.close();
        await load();
        showToast('已彻底移除归档记录');
      } catch (err) {
        alert(err.message || String(err));
      } finally {
        confirmDelete.disabled = false;
        confirmDelete.textContent = '确认彻底移除';
        pendingDelete = null;
      }
    }

    document.querySelector('#refresh').addEventListener('click', load);
    document.querySelector('#cancel').addEventListener('click', () => dialog.close());
    closeDetails.addEventListener('click', () => detailsDialog.close());
    openProject.addEventListener('click', openCurrentProject);
    confirmDelete.addEventListener('click', doDelete);
    q.addEventListener('input', render);
    filter.addEventListener('change', render);
    rows.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const item = archives.find(entry => entry.id === button.dataset.id);
      if (!item) return;
      if (button.dataset.action === 'view') showDetails(item);
      else askDelete(item);
    });

    load().catch(err => {
      meta.textContent = '读取失败';
      rows.innerHTML = '<div class="empty">' + escapeHtml(err.message || err) + '</div>';
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') return text(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/archives') {
      return json(res, 200, {
        codexHome: CODEX_HOME,
        archiveDir: ARCHIVE_DIR,
        archives: getArchives(),
        generatedAt: new Date().toISOString(),
      });
    }
    const detailsMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)\/details$/);
    if (req.method === 'GET' && detailsMatch) {
      return json(res, 200, archiveDetails(detailsMatch[1]));
    }
    const openProjectMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)\/open-project$/);
    if (req.method === 'POST' && openProjectMatch) {
      return json(res, 200, openProject(openProjectMatch[1]));
    }
    const deleteMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, deleteArchive(deleteMatch[1], body.mode || 'file'));
    }
    text(res, 404, 'Not found');
  } catch (err) {
    json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Codex archive manager: http://127.0.0.1:${PORT}`);
  console.log(`Reading ${ARCHIVE_DIR}`);
});
