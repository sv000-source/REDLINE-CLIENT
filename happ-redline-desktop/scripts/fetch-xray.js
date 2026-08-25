'use strict';

// Восстановлено из chat_history.txt (1.3.1-beta), приведено к состоянию 1.8.1-beta:
// отдельный compatibility-core больше не бандлится — insecure=1 обслуживает Sing-box TUN.
// XrayManager по-прежнему умеет использовать xray-legacy.exe, если положить его в vendor/xray/windows-x64.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = 'v26.7.28';
const FILE = 'Xray-windows-64.zip';
const SHA256 = 'c7172078fca4711bcd92a4774dcd1822544579c58816197575c47533317fd8d1';
const URL = `https://github.com/XTLS/Xray-core/releases/download/${VERSION}/${FILE}`;
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'vendor', 'xray', 'windows-x64');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-xray-'));
  const archive = path.join(tempRoot, `${VERSION}.zip`);
  const output = path.join(tempRoot, 'extracted');
  console.log(`Downloading official Xray Core ${VERSION}…`);
  const response = await fetch(URL, { redirect: 'follow', headers: { 'user-agent': 'REDLINE-build-script/1.8' } });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  if (digest !== SHA256) throw new Error(`SHA-256 mismatch for ${VERSION}: expected ${SHA256}, got ${digest}`);
  console.log(`Verified ${VERSION} SHA-256: ${digest}`);
  fs.writeFileSync(archive, data);
  fs.mkdirSync(output, { recursive: true });
  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${output.replaceAll("'", "''")}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
  } else execFileSync('unzip', ['-q', '-o', archive, '-d', output], { stdio: 'inherit' });
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(output, target, { recursive: true });
  fs.writeFileSync(path.join(target, 'REDLINE-CORE-SELECTION.txt'), [
    `Xray ${VERSION} is used for HTTP/SOCKS Proxy mode.`,
    'TLS links with insecure=1 must use the Sing-box TUN engine, which supports insecure TLS without the removed Xray allowInsecure field.',
    `Xray ZIP SHA-256: ${SHA256}`,
    ''
  ].join('\n'));
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(`Xray installed in ${target}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
