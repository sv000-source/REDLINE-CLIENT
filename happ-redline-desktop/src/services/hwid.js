'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 15_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function normalizePart(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text || /TO BE FILLED|DEFAULT STRING|UNKNOWN|NONE|SYSTEM SERIAL/i.test(text)) return '';
  return text.replace(/[^A-Z0-9._-]/g, '');
}

function formatHashAsId(hex) {
  const value = String(hex).replace(/[^a-f0-9]/gi, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`;
}

function identityFromParts(parts, options = {}) {
  const normalized = [parts.machineGuid, parts.cpuId, parts.boardSerial, parts.biosSerial, parts.boardProduct]
    .map(normalizePart).filter(Boolean);
  if (!normalized.length) normalized.push(normalizePart(options.fallback || `${os.hostname()}-${os.arch()}`));
  const digest = crypto.createHash('sha256').update(normalized.join('|')).digest('hex');
  const release = String(options.release || os.release());
  const build = Number(release.split('.')[2] || 0);
  return {
    hwid: formatHashAsId(digest),
    source: 'hardware-sha256',
    deviceOs: 'Windows',
    deviceModel: 'Desktop',
    osVersion: build >= 22000 ? '11' : '10',
    locale: options.locale || 'ru-RU',
    generatedAt: new Date().toISOString()
  };
}

async function createHardwareIdentity(options = {}) {
  const platform = options.platform || process.platform;
  const runner = options.runner || execFileAsync;
  if (platform !== 'win32') return identityFromParts({}, { fallback: `${os.hostname()}-${os.arch()}`, release: os.release(), locale: options.locale });
  const script = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$cpu=(Get-CimInstance Win32_Processor|Select-Object -First 1 -ExpandProperty ProcessorId);',
    '$board=Get-CimInstance Win32_BaseBoard|Select-Object -First 1;',
    '$bios=(Get-CimInstance Win32_BIOS|Select-Object -First 1 -ExpandProperty SerialNumber);',
    '$guid=(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Cryptography" -Name MachineGuid).MachineGuid;',
    '[pscustomobject]@{machineGuid=$guid;cpuId=$cpu;boardSerial=$board.SerialNumber;boardProduct=$board.Product;biosSerial=$bios}|ConvertTo-Json -Compress'
  ].join(' ');
  try {
    const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return identityFromParts(JSON.parse(stdout.trim() || '{}'), { release: os.release(), locale: options.locale });
  } catch (_) {
    return identityFromParts({}, { fallback: `${os.hostname()}-${os.arch()}`, release: os.release(), locale: options.locale });
  }
}

function requestHeaders(identity, version = '1.8.1-beta') {
  if (!identity?.hwid) return { 'user-agent': `REDLINE-Client/${version} (Windows x64)` };
  return {
    'user-agent': `REDLINE-Client/${version} (Windows x64; HWID)`,
    'x-hwid': identity.hwid,
    'x-device-os': identity.deviceOs || 'Windows',
    'x-device-model': identity.deviceModel || 'Desktop',
    'x-ver-os': identity.osVersion || '11',
    'x-device-locale': identity.locale || 'ru-RU'
  };
}

module.exports = { createHardwareIdentity, identityFromParts, requestHeaders, formatHashAsId, normalizePart };
