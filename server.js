#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const ARCHIVE_DIR = path.join(CODEX_HOME, 'archived_sessions');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const BACKUP_DIR = path.join(CODEX_HOME, 'archive-manager-backups');
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

function isInsideDir(base, target) {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function idFromArchiveName(name) {
  const match = name.match(/(019e[0-9a-f-]+)\.jsonl$/);
  return match ? match[1] : '';
}

function rolloutTimeFromName(name) {
  const match = name.match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return match ? `${match[1]} ${match[2]}:${match[3]}:${match[4]}` : '';
}

function sessionPathFromArchiveName(name) {
  const match = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) throw new Error(`Cannot infer session date from archive filename: ${name}`);
  return path.join(SESSIONS_DIR, match[1], match[2], match[3], name);
}

function localTime(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('en-US', {
    hour12: false,
  });
}

function compactOneLine(value, maxLength = 120) {
  const oneLine = String(value || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 3)}...` : oneLine;
}

function readSessionNames() {
  const names = new Map();
  if (!fs.existsSync(SESSION_INDEX)) return names;

  const lines = fs.readFileSync(SESSION_INDEX, 'utf8').split(/\n/).filter(Boolean);
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record?.id || !/^019e[0-9a-f-]+$/.test(record.id)) continue;
    const name = compactOneLine(record.thread_name);

    const updatedAt = Date.parse(record.updated_at || '') || 0;
    const existing = names.get(record.id) || { name: '', updatedAt: 0, aliases: [] };
    if (name && !existing.aliases.includes(name)) {
      existing.aliases.push(name);
    }
    if (name && (!existing.name || updatedAt >= existing.updatedAt)) {
      existing.name = name;
      existing.updatedAt = updatedAt;
    } else if (updatedAt > existing.updatedAt) {
      existing.updatedAt = updatedAt;
    }
    names.set(record.id, existing);
  }

  return names;
}

function compactTitle(row, id, sessionName) {
  if (sessionName?.name) return sessionName.name;
  const raw = String(row?.title || row?.first_user_message || row?.preview || '').trim();
  if (!raw) return `(Untitled: ${id})`;
  const oneLine = compactOneLine(raw);
  if (oneLine.startsWith('Automation:')) {
    const match = oneLine.match(/Last run: (never|[0-9TZ:.\-]+)/);
    return match ? `Automation: EyeFlow conversation rotation monitor (${match[1]})` : 'Automation: EyeFlow conversation rotation monitor';
  }
  return oneLine;
}

function archiveAliases(row, sessionName) {
  const aliases = sessionName?.aliases ? [...sessionName.aliases] : [];
  for (const value of [row?.title, row?.first_user_message, row?.preview]) {
    const alias = compactOneLine(value);
    if (alias && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
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
  const sessionNames = readSessionNames();
  const byId = new Map(rows.map(row => [row.id, row]));
  const files = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter(name => name.endsWith('.jsonl'))
    : [];

  const fileEntries = files.map(name => {
    const id = idFromArchiveName(name);
    const file = path.join(ARCHIVE_DIR, name);
    const stat = fs.statSync(file);
    const row = byId.get(id);
    const sessionName = sessionNames.get(id);
    return {
      id,
      title: compactTitle(row, id, sessionName),
      aliases: archiveAliases(row, sessionName),
      rolloutTime: rolloutTimeFromName(name),
      updatedAt: localTime(row?.updated_at),
      archivedAt: localTime(row?.archived_at),
      sizeKB: Math.round(stat.size / 1024),
      file,
      fileName: name,
      exists: true,
      inDatabase: Boolean(row),
      archivedFlag: Boolean(row?.archived),
      status: 'archived',
    };
  });

  const archivedRowsWithoutFile = rows
    .filter(row => row.archived && !fileEntries.some(entry => entry.id === row.id))
    .map(row => {
      const sessionName = sessionNames.get(row.id);
      const file = row.rollout_path || '';
      const exists = Boolean(file && fs.existsSync(file));
      const stat = exists ? fs.statSync(file) : null;
      return {
        id: row.id,
        title: compactTitle(row, row.id, sessionName),
        aliases: archiveAliases(row, sessionName),
        rolloutTime: '',
        updatedAt: localTime(row.updated_at),
        archivedAt: localTime(row.archived_at),
        sizeKB: stat ? Math.round(stat.size / 1024) : 0,
        file,
        fileName: path.basename(file || ''),
        exists,
        inDatabase: true,
        archivedFlag: true,
        status: exists ? 'archived' : 'missing',
      };
    });

  const currentRows = rows
    .filter(row => !row.archived)
    .map(row => {
      const sessionName = sessionNames.get(row.id);
      const file = row.rollout_path || '';
      const exists = Boolean(file && fs.existsSync(file));
      const stat = exists ? fs.statSync(file) : null;
      return {
        id: row.id,
        title: compactTitle(row, row.id, sessionName),
        aliases: archiveAliases(row, sessionName),
        rolloutTime: '',
        updatedAt: localTime(row.updated_at),
        archivedAt: '',
        sizeKB: stat ? Math.round(stat.size / 1024) : 0,
        file,
        fileName: path.basename(file || ''),
        exists,
        inDatabase: true,
        archivedFlag: false,
        indexed: Boolean(sessionName),
        status: exists ? (sessionName ? 'current' : 'unlisted') : 'missing',
      };
    });

  return [...fileEntries, ...archivedRowsWithoutFile, ...currentRows]
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
    title: compactTitle(row, id, readSessionNames().get(id)),
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

function revealRecordFile(id) {
  const row = getThreadRow(id);
  const file = archivePathFor(id, row);
  if (!file) throw new Error('This session has no record file to reveal');
  if (!fs.existsSync(file)) throw new Error('Record file no longer exists');

  if (process.platform === 'darwin') {
    cp.execFileSync('open', ['-R', file], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    cp.execFileSync('explorer', [`/select,${file}`], { stdio: 'ignore' });
  } else {
    cp.execFileSync('xdg-open', [path.dirname(file)], { stdio: 'ignore' });
  }

  return { revealed: true, file };
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

function appendToSessionIndex(id, threadName, updatedAt) {
  const removedExisting = removeFromSessionIndex(id);
  const record = {
    id,
    thread_name: compactOneLine(threadName, 160) || `(Untitled: ${id})`,
    updated_at: new Date(Number(updatedAt || 0) * 1000).toISOString(),
  };
  fs.appendFileSync(SESSION_INDEX, `${JSON.stringify(record)}\n`, 'utf8');
  return removedExisting;
}

function createRestoreBackups(id, archiveFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, `${stamp}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const backups = [];

  if (fs.existsSync(STATE_DB)) {
    const target = path.join(dir, 'state_5.sqlite');
    fs.copyFileSync(STATE_DB, target);
    backups.push(target);
  }
  if (fs.existsSync(SESSION_INDEX)) {
    const target = path.join(dir, 'session_index.jsonl');
    fs.copyFileSync(SESSION_INDEX, target);
    backups.push(target);
  }
  if (archiveFile && fs.existsSync(archiveFile)) {
    const target = path.join(dir, path.basename(archiveFile));
    fs.copyFileSync(archiveFile, target);
    backups.push(target);
  }

  return { dir, backups };
}

function restoreArchive(id) {
  if (!id || !/^019e[0-9a-f-]+$/.test(id)) throw new Error('Invalid archive id');

  const entry = getArchives().find(item => item.id === id && item.status === 'archived' && item.exists);
  if (!entry) throw new Error('Archived session file was not found');
  if (path.dirname(entry.file) !== ARCHIVE_DIR) throw new Error(`Refusing to restore outside archive dir: ${entry.file}`);

  const row = getThreadRow(id);
  if (!row) throw new Error('Codex database row was not found for this archive');

  const destination = sessionPathFromArchiveName(entry.fileName);
  if (fs.existsSync(destination)) throw new Error(`A session file already exists at ${destination}`);

  const backup = createRestoreBackups(id, entry.file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(entry.file, destination, fs.constants.COPYFILE_EXCL);

  sqliteRun(`
    update threads
    set archived = 0,
        archived_at = null,
        rollout_path = ${sqlQuote(destination)}
    where id = ${sqlQuote(id)};
  `);
  appendToSessionIndex(id, compactTitle(row, id, readSessionNames().get(id)), row.updated_at);
  fs.unlinkSync(entry.file);

  return {
    id,
    restored: true,
    destination,
    backupDir: backup.dir,
  };
}

function deleteArchive(id, mode) {
  if (!id || !/^019e[0-9a-f-]+$/.test(id)) throw new Error('Invalid archive id');
  if (!['file', 'index', 'local-record', 'missing-record'].includes(mode)) throw new Error('Invalid delete mode');

  if (mode === 'local-record') return deleteLocalRecord(id);
  if (mode === 'missing-record') return removeMissingRecord(id);

  const entries = getArchives().filter(entry => entry.id === id && entry.status !== 'current');
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

function removeMissingRecord(id) {
  const entry = getArchives().find(item => item.id === id && item.status === 'missing');
  if (!entry) throw new Error('Missing-file record was not found');

  const result = {
    id,
    mode: 'missing-record',
    removedFiles: [],
    removedDatabaseRow: false,
    removedSessionIndexLines: false,
  };

  sqliteRun(`delete from threads where id = ${sqlQuote(id)};`);
  result.removedDatabaseRow = true;
  result.removedSessionIndexLines = removeFromSessionIndex(id);
  return result;
}

function deleteLocalRecord(id) {
  const entry = getArchives().find(item => item.id === id && item.status === 'unlisted');
  if (!entry) throw new Error('Local record was not found');

  const result = {
    id,
    mode: 'local-record',
    removedFiles: [],
    removedDatabaseRow: false,
    removedSessionIndexLines: false,
  };

  if (entry.exists && entry.file) {
    if (!isInsideDir(SESSIONS_DIR, entry.file)) {
      throw new Error(`Refusing to delete outside Codex sessions dir: ${entry.file}`);
    }
    fs.unlinkSync(entry.file);
    result.removedFiles.push(entry.file);
  }

  sqliteRun(`delete from threads where id = ${sqlQuote(id)};`);
  result.removedDatabaseRow = true;
  result.removedSessionIndexLines = removeFromSessionIndex(id);
  return result;
}

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Archive Manager</title>
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
      grid-template-columns: minmax(240px, 1fr) 160px 150px auto auto;
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
      white-space: nowrap;
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
    .action-guide {
      border-bottom: 1px solid var(--line);
      background: #fff;
      padding: 0 14px;
    }
    .action-guide summary {
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      color: #3f464c;
      font-size: 13px;
      font-weight: 680;
      list-style: none;
      user-select: none;
    }
    .action-guide summary::-webkit-details-marker {
      display: none;
    }
    .action-guide summary::after {
      content: "";
      width: 7px;
      height: 7px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      margin-left: 2px;
      margin-top: -3px;
      transition: transform .16s ease;
    }
    .action-guide[open] summary::after {
      transform: rotate(225deg);
      margin-top: 3px;
    }
    .guide-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 14px;
      margin: 0;
      padding: 0;
    }
    .guide-item {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .guide-item dt {
      color: var(--text);
      font-size: 13px;
      font-weight: 720;
    }
    .guide-item dd {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .guide-note {
      margin: 12px 0 14px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
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
      grid-template-columns: minmax(0, 1fr) auto;
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
      display: none;
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
      align-items: center;
    }
    .row-actions button,
    .actions-menu summary {
      height: 34px;
      padding: 0 9px;
      font-size: 13px;
    }
    .actions-menu {
      position: relative;
    }
    .actions-menu summary {
      display: inline-flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
      list-style: none;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--text);
      font-weight: 620;
    }
    .actions-menu summary::-webkit-details-marker {
      display: none;
    }
    .actions-menu[open] summary {
      border-color: var(--accent);
      outline: 3px solid rgba(23, 107, 135, .12);
    }
    .actions-menu-list {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 3;
      display: grid;
      min-width: 148px;
      padding: 6px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }
    .actions-menu-list button {
      width: 100%;
      justify-content: flex-start;
      text-align: left;
      border-color: transparent;
      background: transparent;
    }
    .actions-menu-list button:hover:not(:disabled) {
      background: var(--panel-soft);
      transform: none;
    }
    .actions-menu-list button.danger {
      color: var(--danger);
      background: transparent;
    }
    .actions-menu-list button.danger:hover:not(:disabled) {
      background: var(--danger-bg);
      border-color: transparent;
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
    .status-badge {
      color: #3d454b;
      background: #eef0ec;
      border-color: var(--line-strong);
      font-weight: 650;
    }
    .status-badge.unlisted {
      color: #725217;
      background: #fff7df;
      border-color: #eed38a;
    }
    .status-badge.missing-status {
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
      .guide-grid {
        grid-template-columns: 1fr 1fr;
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
        width: 100%;
      }
      .row-actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
      }
      .actions-menu-list button {
        width: 100%;
      }
      .guide-grid {
        grid-template-columns: 1fr;
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
    body.sidebar .action-guide {
      padding: 0 12px;
    }
    body.sidebar .guide-grid {
      grid-template-columns: 1fr;
      gap: 8px;
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
      flex: 1 1 120px;
      height: 34px;
      padding: 0 8px;
      font-size: 13px;
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
          <h1>Codex Archive Manager</h1>
          <div class="subtitle" id="archivePath">Local archive</div>
        </div>
      </div>
    </div>
  </header>
  <main>
    <section class="workspace" aria-label="Archive list">
      <div class="controls">
        <label class="sr-only" for="q">Search</label>
        <input id="q" placeholder="Search title, time, or filename">
        <label class="sr-only" for="statusFilter">Status</label>
        <select id="statusFilter">
          <option value="archived">Archived sessions</option>
          <option value="current">Current sessions</option>
          <option value="unlisted">Not in sidebar</option>
          <option value="missing">Missing file</option>
          <option value="all">All sessions</option>
        </select>
        <label class="sr-only" for="filter">Filter</label>
        <select id="filter">
          <option value="all">All types</option>
          <option value="normal">Conversations</option>
          <option value="automation">Automation runs</option>
        </select>
        <button id="refresh" class="primary">Refresh</button>
        <span id="meta" class="meta">0 / 0</span>
      </div>
      <details class="action-guide">
        <summary>Action guide</summary>
        <dl class="guide-grid">
          <div class="guide-item">
            <dt>Preview</dt>
            <dd>Read the conversation before changing anything.</dd>
          </div>
          <div class="guide-item">
            <dt>Restore</dt>
            <dd>Move an archived session back to the Codex sidebar.</dd>
          </div>
          <div class="guide-item">
            <dt>More > Reveal</dt>
            <dd>Show the local record file in Finder or the system file manager.</dd>
          </div>
          <div class="guide-item">
            <dt>More > Delete archive</dt>
            <dd>Delete an archived record file and remove its Codex index row.</dd>
          </div>
          <div class="guide-item">
            <dt>More > Delete local record</dt>
            <dd>Delete a local record that exists on disk but is not shown in the Codex sidebar.</dd>
          </div>
          <div class="guide-item">
            <dt>More > Remove record</dt>
            <dd>Remove a broken database/sidebar reference when the record file is already missing.</dd>
          </div>
        </dl>
        <p class="guide-note">These actions manage local Codex session records only. They do not modify project files, folders, or apps.</p>
      </details>
      <div id="rows" class="archive-list"></div>
    </section>
  </main>

  <dialog id="confirm">
    <div class="modal">
      <h2 id="confirmTitle">Confirm delete</h2>
      <p id="confirmBody"></p>
      <div class="modal-actions">
        <button id="cancel">Cancel</button>
        <button id="confirmDelete" class="danger">Confirm delete</button>
      </div>
    </div>
  </dialog>
  <dialog id="details" class="detail-dialog">
    <div class="modal">
      <h2 id="detailsTitle">Archive Preview</h2>
      <div class="detail-body">
        <dl class="detail-meta" id="detailsMeta"></dl>
        <div class="transcript" id="detailsMessages"></div>
      </div>
      <div class="modal-actions">
        <button id="openProject" class="ghost">Open project folder</button>
        <button id="closeDetails" class="primary">Close</button>
      </div>
    </div>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    const params = new URLSearchParams(location.search);
    const demoMode = params.get('demo') === '1';

    if (params.get('mode') === 'sidebar') {
      document.body.classList.add('sidebar');
    }

    let archives = [];
    let pendingAction = null;
    const rows = document.querySelector('#rows');
    const q = document.querySelector('#q');
    const statusFilter = document.querySelector('#statusFilter');
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

    function demoArchives() {
      return [
        {
          id: 'demo-archive-1',
          title: 'Review Codex archive cleanup',
          rolloutTime: '2026-06-09 16:42:18',
          archivedAt: '2026/6/9 16:45:02',
          updatedAt: '2026-06-09 16:42:18',
          fileName: 'rollout-2026-06-09T16-42-18-demo-archive-1.jsonl',
          file: 'rollout-2026-06-09T16-42-18-demo-archive-1.jsonl',
          exists: true,
          sizeKB: 84,
          status: 'archived'
        },
        {
          id: 'demo-archive-2',
          title: 'Automation: Project status check',
          rolloutTime: '2026-06-09 15:30:04',
          archivedAt: '2026/6/9 15:42:11',
          updatedAt: '2026-06-09 15:30:04',
          fileName: 'rollout-2026-06-09T15-30-04-demo-archive-2.jsonl',
          file: 'rollout-2026-06-09T15-30-04-demo-archive-2.jsonl',
          exists: true,
          sizeKB: 131,
          status: 'archived'
        },
        {
          id: 'demo-archive-3',
          title: 'Look back at an archived conversation',
          rolloutTime: '2026-06-08 22:18:36',
          archivedAt: '2026/6/9 09:12:45',
          updatedAt: '2026-06-08 22:18:36',
          fileName: 'rollout-2026-06-08T22-18-36-demo-archive-3.jsonl',
          file: 'rollout-2026-06-08T22-18-36-demo-archive-3.jsonl',
          exists: true,
          sizeKB: 57,
          status: 'archived'
        },
        {
          id: 'demo-current-1',
          title: 'EyeFlow1.3',
          rolloutTime: '',
          archivedAt: '',
          updatedAt: '2026-06-09 18:49:41',
          fileName: 'rollout-2026-06-09T18-21-47-demo-current-1.jsonl',
          file: 'rollout-2026-06-09T18-21-47-demo-current-1.jsonl',
          exists: true,
          sizeKB: 96,
          status: 'current'
        },
        {
          id: 'demo-unlisted-1',
          title: 'Set up a weekday morning briefing automation',
          rolloutTime: '',
          archivedAt: '',
          updatedAt: '2026-06-01 15:43:07',
          fileName: 'rollout-2026-05-29T21-38-06-demo-unlisted-1.jsonl',
          file: 'rollout-2026-05-29T21-38-06-demo-unlisted-1.jsonl',
          exists: true,
          sizeKB: 203,
          status: 'unlisted'
        },
        {
          id: 'demo-missing-1',
          title: 'Old session with missing record file',
          rolloutTime: '',
          archivedAt: '2026/6/4 12:18:22',
          updatedAt: '2026-06-04 12:18:22',
          fileName: 'rollout-2026-06-04T12-18-22-demo-missing-1.jsonl',
          file: '/demo/missing/rollout-2026-06-04T12-18-22-demo-missing-1.jsonl',
          exists: false,
          sizeKB: 0,
          status: 'missing'
        }
      ];
    }

    function archiveKind(item) {
      if (item.title.startsWith('Automation:')) return 'Automation';
      return 'Conversation';
    }

    function statusLabel(item) {
      if (item.status === 'current') return 'Current';
      if (item.status === 'unlisted') return 'Not in sidebar';
      if (item.status === 'missing') return 'Missing file';
      return 'Archived';
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
        if (statusFilter.value === 'archived' && item.status === 'current') return false;
        if (statusFilter.value === 'archived' && item.status === 'unlisted') return false;
        if (statusFilter.value === 'archived' && item.status === 'missing') return false;
        if (statusFilter.value === 'current' && item.status !== 'current') return false;
        if (statusFilter.value === 'unlisted' && item.status !== 'unlisted') return false;
        if (statusFilter.value === 'missing' && item.status !== 'missing') return false;
        if (filter.value === 'normal' && item.title.startsWith('Automation:')) return false;
        if (filter.value === 'automation' && !item.title.startsWith('Automation:')) return false;
        if (!term) return true;
        return [item.title, statusLabel(item), ...(item.aliases || []), item.rolloutTime, item.archivedAt, item.fileName, item.id]
          .join(' ')
          .toLowerCase()
          .includes(term);
      });
    }

    function render() {
      const items = visibleItems();
      meta.textContent = items.length + ' / ' + archives.length;
      if (!items.length) {
        rows.innerHTML = '<div class="empty">No matching archives</div>';
        return;
      }
      rows.innerHTML = items.map(item => {
        const size = item.exists ? item.sizeKB + ' KB' : '<span class="missing">Record file is missing</span>';
        const kind = archiveKind(item);
        const badgeClass = kind === 'Automation' ? 'badge auto' : kind === 'Missing file' ? 'badge missing' : 'badge';
        const statusClass = item.status === 'unlisted'
          ? 'badge status-badge unlisted'
          : item.status === 'missing'
            ? 'badge status-badge missing-status'
            : 'badge status-badge';
        const deleteButton = item.status === 'archived'
          ? '<button data-action="index" data-id="' + escapeHtml(item.id) + '" class="danger" title="Delete archive">Delete archive</button>'
          : item.status === 'unlisted'
            ? '<button data-action="local-record" data-id="' + escapeHtml(item.id) + '" class="danger" title="Delete local record">Delete local record</button>'
            : item.status === 'missing'
              ? '<button data-action="missing-record" data-id="' + escapeHtml(item.id) + '" title="Remove broken record">Remove record</button>'
              : '';
        const restoreButton = item.status === 'archived' && item.exists
          ? '<button data-action="restore" data-id="' + escapeHtml(item.id) + '" class="ghost" title="Restore to Codex sidebar">Restore</button>'
          : '';
        const revealButton = item.exists
          ? '<button data-action="reveal" data-id="' + escapeHtml(item.id) + '" title="Reveal record file">Reveal</button>'
          : '';
        const menuItems = [revealButton, deleteButton].filter(Boolean).join('');
        const moreMenu = menuItems
          ? '<details class="actions-menu"><summary>More</summary><div class="actions-menu-list">' + menuItems + '</div></details>'
          : '';
        const dateLabel = item.status === 'archived' ? 'Archived ' : 'Updated ';
        const dateValue = item.status === 'archived' ? (item.archivedAt || 'Unknown') : (item.updatedAt || 'Unknown');
        return ''
          + '<article class="archive-row">'
          + '<div class="row-main">'
          + '<div class="row-topline"><span class="' + statusClass + '">' + escapeHtml(statusLabel(item)) + '</span><span class="' + badgeClass + '">' + escapeHtml(kind) + '</span><span class="row-title">' + escapeHtml(item.title) + '</span></div>'
          + '<div class="row-meta"><span>Session ' + escapeHtml(item.rolloutTime || item.updatedAt || '') + '</span><span>' + dateLabel + escapeHtml(dateValue) + '</span><span>' + size + '</span></div>'
          + '</div>'
          + '<div class="row-actions">'
          + '<button data-action="view" data-id="' + escapeHtml(item.id) + '" class="ghost">Preview</button>'
          + restoreButton
          + moreMenu
          + '</div>'
          + '</article>';
      }).join('');
    }

    async function load() {
      meta.textContent = 'Loading';
      if (demoMode) {
        archives = demoArchives();
        archivePath.textContent = 'Demo data. No local Codex files are read.';
        render();
        return;
      }
      const res = await fetch('/api/archives', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      archives = data.archives;
      archivePath.textContent = data.archiveDir || 'Local archive';
      render();
    }

    function askDelete(item) {
      const isLocalRecord = item.status === 'unlisted';
      const isMissingRecord = item.status === 'missing';
      pendingAction = {
        type: 'delete',
        id: item.id,
        mode: isMissingRecord ? 'missing-record' : isLocalRecord ? 'local-record' : 'index'
      };
      const confirmTitle = document.querySelector('#confirmTitle');
      confirmTitle.textContent = isMissingRecord
        ? 'Remove this missing-file record?'
        : isLocalRecord
          ? 'Delete this local record?'
          : 'Delete this archive?';
      confirmDelete.textContent = isMissingRecord
        ? 'Remove record'
        : isLocalRecord
          ? 'Delete local record'
          : 'Delete archive';
      confirmDelete.className = isMissingRecord ? '' : 'danger';
      const notes = isMissingRecord
        ? [
            ['✓', 'Removes this broken reference from the Codex database.'],
            ['✓', 'Removes any matching sidebar index entry.'],
            ['✓', 'Does not delete any conversation file, because the file is already missing.'],
            ['✓', 'Does not modify any files in the project used by this conversation.']
          ]
        : isLocalRecord
        ? [
            ['✓', 'Deletes this local Codex session file.'],
            ['✓', 'Removes this local record from the Codex database.'],
            ['✓', 'Does not modify any files in the project used by this conversation.']
          ]
        : [
            ['✓', 'Deletes the archived conversation file.'],
            ['✓', 'Removes this item from the Codex archive list.'],
            ['✓', 'Does not modify any files in the project used by this conversation.']
          ];
      confirmBody.innerHTML = ''
        + '<span class="delete-summary">'
        + '<span class="delete-title">' + (isMissingRecord ? 'Broken record to remove' : isLocalRecord ? 'Local record to delete' : 'Archive to delete') + '<span class="delete-name">' + escapeHtml(item.title) + '</span></span>'
        + '<span class="delete-title">Record file<span class="delete-name">' + escapeHtml(item.fileName || item.file || 'Not found') + '</span></span>'
        + '<span class="delete-note">'
        + notes.map(note => '<div><strong>' + escapeHtml(note[0]) + '</strong><span>' + escapeHtml(note[1]) + '</span></div>').join('')
        + '</span>'
        + '</span>';
      dialog.showModal();
    }

    function askRestore(item) {
      pendingAction = { type: 'restore', id: item.id };
      const confirmTitle = document.querySelector('#confirmTitle');
      confirmTitle.textContent = 'Restore this session?';
      confirmDelete.textContent = 'Restore';
      confirmDelete.className = 'primary';
      const notes = [
        ['✓', 'Moves this session back to the Codex sidebar index.'],
        ['✓', 'Copies the record file back into the Codex sessions folder.'],
        ['✓', 'Creates a local backup before changing Codex metadata.'],
        ['✓', 'Does not modify any files in the project used by this conversation.']
      ];
      confirmBody.innerHTML = ''
        + '<span class="delete-summary">'
        + '<span class="delete-title">Session to restore<span class="delete-name">' + escapeHtml(item.title) + '</span></span>'
        + '<span class="delete-title">Archive file<span class="delete-name">' + escapeHtml(item.fileName || item.file || 'Not found') + '</span></span>'
        + '<span class="delete-note">'
        + notes.map(note => '<div><strong>' + escapeHtml(note[0]) + '</strong><span>' + escapeHtml(note[1]) + '</span></div>').join('')
        + '</span>'
        + '</span>';
      dialog.showModal();
    }

    async function showDetails(item) {
      currentDetailsId = item.id;
      detailsTitle.textContent = 'Loading';
      detailsMeta.innerHTML = '';
      detailsMessages.innerHTML = '<div class="empty">Loading archive content</div>';
      openProject.disabled = true;
      detailsDialog.showModal();
      if (demoMode) {
        detailsTitle.textContent = item.title || 'Archive preview';
        openProject.disabled = true;
        openProject.textContent = 'Demo mode';
        detailsMeta.innerHTML = ''
          + '<dt>Project path</dt><dd>/demo/project</dd>'
          + '<dt>Archived at</dt><dd>' + escapeHtml(item.archivedAt || 'Unknown') + '</dd>'
          + '<dt>Archive file</dt><dd>' + escapeHtml(item.fileName || item.file || 'demo.jsonl') + '</dd>';
        detailsMessages.innerHTML = ''
          + '<article class="message user"><div class="message-role">You</div><pre class="message-text">I want to review what happened in this archived conversation.</pre></article>'
          + '<article class="message"><div class="message-role">Codex</div><pre class="message-text">The preview shows archived user and assistant messages so you can check the content before deleting the archive.</pre></article>';
        return;
      }
      try {
        const res = await fetch('/api/archives/' + item.id + '/details', { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        detailsTitle.textContent = data.title || 'Archive preview';
        openProject.disabled = !data.projectExists;
        openProject.textContent = data.projectExists ? 'Open project folder' : 'Project folder missing';
        detailsMeta.innerHTML = ''
          + '<dt>Project path</dt><dd>' + escapeHtml(data.cwd || 'Unknown') + '</dd>'
          + '<dt>Archived at</dt><dd>' + escapeHtml(data.archivedAt || 'Unknown') + '</dd>'
          + '<dt>Archive file</dt><dd>' + escapeHtml(data.rolloutPath || 'Not found') + '</dd>';
        if (!data.messages.length) {
          detailsMessages.innerHTML = '<div class="empty">No user or assistant messages to preview</div>';
          return;
        }
        detailsMessages.innerHTML = data.messages.map(message => {
          const role = message.role === 'user' ? 'You' : 'Codex';
          const className = message.role === 'user' ? 'message user' : 'message';
          return ''
            + '<article class="' + className + '">'
            + '<div class="message-role">' + role + '</div>'
            + '<pre class="message-text">' + escapeHtml(message.text) + '</pre>'
            + '</article>';
        }).join('');
      } catch (err) {
        detailsTitle.textContent = 'Failed to load';
        detailsMessages.innerHTML = '<div class="empty">' + escapeHtml(err.message || String(err)) + '</div>';
      }
    }

    async function openCurrentProject() {
      if (!currentDetailsId) return;
      openProject.disabled = true;
      try {
        const res = await fetch('/api/archives/' + currentDetailsId + '/open-project', { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        showToast('Project folder opened');
      } catch (err) {
        alert(err.message || String(err));
      } finally {
        openProject.disabled = false;
      }
    }

    async function revealCurrentFile(id) {
      if (demoMode) {
        showToast('Demo mode has no local file to reveal');
        return;
      }
      try {
        const res = await fetch('/api/archives/' + id + '/reveal-file', { method: 'POST' });
        if (!res.ok) throw new Error(await res.text());
        showToast('Record file revealed');
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    async function runPendingAction() {
      if (!pendingAction) return;
      const action = pendingAction;
      if (demoMode) {
        dialog.close();
        showToast(action.type === 'restore' ? 'Demo mode does not restore sessions' : 'Demo mode does not delete files');
        pendingAction = null;
        return;
      }
      confirmDelete.disabled = true;
      confirmDelete.textContent = action.type === 'restore' ? 'Restoring' : 'Deleting';
      try {
        const res = action.type === 'restore'
          ? await fetch('/api/archives/' + action.id + '/restore', { method: 'POST' })
          : await fetch('/api/archives/' + action.id, {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ mode: action.mode }),
            });
        if (!res.ok) throw new Error(await res.text());
        dialog.close();
        await load();
        if (action.type === 'restore') showToast('Session restored to sidebar');
        else if (action.mode === 'missing-record') showToast('Missing-file record removed');
        else showToast(action.mode === 'local-record' ? 'Local record deleted' : 'Archive deleted');
      } catch (err) {
        alert(err.message || String(err));
      } finally {
        confirmDelete.disabled = false;
        if (action.type === 'restore') {
          confirmDelete.textContent = 'Restore';
          confirmDelete.className = 'primary';
        } else {
          confirmDelete.textContent = action.mode === 'missing-record'
            ? 'Remove record'
            : action.mode === 'local-record'
              ? 'Delete local record'
              : 'Delete archive';
          confirmDelete.className = action.mode === 'missing-record' ? '' : 'danger';
        }
        pendingAction = null;
      }
    }

    document.querySelector('#refresh').addEventListener('click', load);
    document.querySelector('#cancel').addEventListener('click', () => {
      pendingAction = null;
      dialog.close();
    });
    closeDetails.addEventListener('click', () => detailsDialog.close());
    openProject.addEventListener('click', openCurrentProject);
    confirmDelete.addEventListener('click', runPendingAction);
    q.addEventListener('input', render);
    statusFilter.addEventListener('change', render);
    filter.addEventListener('change', render);
    rows.addEventListener('click', event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      button.closest('details')?.removeAttribute('open');
      const item = archives.find(entry => entry.id === button.dataset.id);
      if (!item) return;
      if (button.dataset.action === 'view') showDetails(item);
      else if (button.dataset.action === 'reveal') revealCurrentFile(item.id);
      else if (button.dataset.action === 'restore') askRestore(item);
      else askDelete(item);
    });

    load().catch(err => {
      meta.textContent = 'Failed to load';
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
    const revealFileMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)\/reveal-file$/);
    if (req.method === 'POST' && revealFileMatch) {
      return json(res, 200, revealRecordFile(revealFileMatch[1]));
    }
    const restoreMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)\/restore$/);
    if (req.method === 'POST' && restoreMatch) {
      return json(res, 200, restoreArchive(restoreMatch[1]));
    }
    const deleteMatch = url.pathname.match(/^\/api\/archives\/(019e[0-9a-f-]+)$/);
    if (req.method === 'DELETE' && deleteMatch) {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, deleteArchive(deleteMatch[1], body.mode || 'index'));
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
