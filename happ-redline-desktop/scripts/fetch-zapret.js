'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '1.10.1';
const FILE = `zapret-discord-youtube-${VERSION}.zip`;
const SHA256 = 'f748d61fec75e4edc992cb5b09d554e914197c68c690384aceb61f143d8f76c9';
const URL = `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${VERSION}/${FILE}`;
const LICENSE_URL = `https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/${VERSION}/LICENSE.txt`;
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'vendor', 'zapret', 'windows-x64');

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'REDLINE-build-script/1.1' } });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-zapret-'));
  const archive = path.join(tempRoot, FILE);
  const extracted = path.join(tempRoot, 'extracted');
  console.log(`Downloading Flowseal zapret-discord-youtube ${VERSION}…`);
  const data = await download(URL);
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== SHA256) throw new Error(`SHA-256 mismatch: expected ${SHA256}, got ${digest}`);
  fs.writeFileSync(archive, data);
  fs.mkdirSync(extracted);
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', archive, '-d', extracted], { stdio: 'inherit' });
  }
  const source = path.join(extracted, `zapret-discord-youtube-${VERSION}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(path.join(target, 'LICENSE.txt'), await download(LICENSE_URL));
  fs.writeFileSync(path.join(target, 'REDLINE-SOURCE.txt'), [
    `Flowseal/zapret-discord-youtube ${VERSION}`,
    `https://github.com/Flowseal/zapret-discord-youtube/releases/tag/${VERSION}`,
    `Official ZIP SHA-256: ${SHA256}`,
    'Bundled unmodified. REDLINE launches selected strategy files through a hidden elevated wrapper.',
    ''
  ].join('\n'));
  for (const file of ['list-general-user.txt', 'list-exclude-user.txt', 'ipset-exclude-user.txt', 'ipset-all-user.txt']) {
    const filePath = path.join(target, 'lists', file);
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '');
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Verified SHA-256: ${digest}`);
  console.log(`Zapret installed in ${target}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
