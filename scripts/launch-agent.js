#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const action = process.argv[2];
const label = 'com.lovelle.codex-archive-manager';
const repoDir = path.resolve(__dirname, '..');
const nodePath = process.execPath;
const home = os.homedir();
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const logDir = path.join(home, '.codex', 'archive-manager-logs');

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(command, args, options = {}) {
  return cp.execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function plist(writeMode = false) {
  const outLog = path.join(logDir, 'out.log');
  const errLog = path.join(logDir, 'err.log');
  const writeEnv = writeMode
    ? `    <key>CODEX_ARCHIVE_MANAGER_WRITE</key>
    <string>1</string>
`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(path.join(repoDir, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string>
${writeEnv}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

function bootout() {
  try {
    run('launchctl', ['bootout', `gui/${process.getuid()}`, plistPath]);
  } catch {
    try {
      run('launchctl', ['unload', plistPath]);
    } catch {
      // It is fine if the agent was not loaded yet.
    }
  }
}

function install(writeMode = false) {
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  if (fs.existsSync(plistPath)) bootout();
  fs.writeFileSync(plistPath, plist(writeMode), 'utf8');
  run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
  run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
  console.log(`Installed ${label}${writeMode ? ' in write mode' : ''}`);
  console.log(`Open http://127.0.0.1:8787`);
}

function uninstall() {
  bootout();
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(`Uninstalled ${label}`);
}

if (action === 'install') {
  install(false);
} else if (action === 'install-write') {
  install(true);
} else if (action === 'uninstall') {
  uninstall();
} else {
  console.error('Usage: node scripts/launch-agent.js <install|install-write|uninstall>');
  process.exit(1);
}
