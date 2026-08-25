'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '1.13.19';
const FILE = `sing-box-${VERSION}-windows-amd64.zip`;
const SHA256 = 'e011a4def2f5e2b143ed54adb2b1a20a6be407806ab4442f3667f1dd817a2c8d';
const URL = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${FILE}`;
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'vendor', 'sing-box', 'windows-x64');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-singbox-'));
  const archive = path.join(tempRoot, FILE);
  const extracted = path.join(tempRoot, 'extracted');
  console.log(`Downloading sing-box ${VERSION}…`);
  const response = await fetch(URL, { redirect: 'follow', headers: { 'user-agent': 'REDLINE-build-script/1.5' } });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== SHA256) throw new Error(`SHA-256 mismatch: expected ${SHA256}, got ${digest}`);
  fs.writeFileSync(archive, data); fs.mkdirSync(extracted);
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
  } else execFileSync('unzip', ['-q', '-o', archive, '-d', extracted], { stdio: 'inherit' });
  const source = path.join(extracted, `sing-box-${VERSION}-windows-amd64`);
  fs.rmSync(target, { recursive: true, force: true }); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true });
  fs.writeFileSync(path.join(target, 'REDLINE-SOURCE.txt'), [`sing-box ${VERSION}`, `Source: https://github.com/SagerNet/sing-box/releases/tag/v${VERSION}`, `ZIP SHA-256: ${SHA256}`, 'License: GPL-3.0-or-later', ''].join('\n'));
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Verified SHA-256: ${digest}`); console.log(`sing-box installed in ${target}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
