'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const MANAGED_VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 10_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function parseRegOutput(output, name) {
  const line = String(output || '').split(/\r?\n/).find(item => item.trim().toLowerCase().startsWith(name.toLowerCase()));
  if (!line) return { exists: false, name };
  const match = line.trim().match(/^(\S+)\s+(REG_\S+)\s*(.*)$/i);
  if (!match) return { exists: false, name };
  return { exists: true, name, type: match[2].toUpperCase(), value: match[3] || '' };
}

class SystemProxyManager {
  constructor({ directory, platform = process.platform, runner = execFileAsync }) {
    this.platform = platform;
    this.runner = runner;
    this.backupPath = path.join(directory, 'system-proxy-backup.json');
    this.active = false;
  }

  supported() { return this.platform === 'win32'; }

  async readValue(name) {
    try {
      const { stdout } = await this.runner('reg.exe', ['query', REG_KEY, '/v', name]);
      return parseRegOutput(stdout, name);
    } catch (error) {
      if (error.code === 1 || error.code === 'ENOENT') return { exists: false, name };
      throw new Error(`Не удалось прочитать системный Proxy: ${error.message}`);
    }
  }

  async snapshot() {
    const values = {};
    for (const name of MANAGED_VALUES) values[name] = await this.readValue(name);
    return { version: 1, createdAt: new Date().toISOString(), values };
  }

  async writeValue(name, type, value) {
    await this.runner('reg.exe', ['add', REG_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
  }

  async deleteValue(name) {
    try { await this.runner('reg.exe', ['delete', REG_KEY, '/v', name, '/f']); }
    catch (error) { if (error.code !== 1) throw error; }
  }

  async notifyWindows() {
    const script = [
      '$sig = @"',
      '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
      '"@;',
      'Add-Type -MemberDefinition $sig -Namespace WinInet -Name NativeMethods;',
      '[WinInet.NativeMethods]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null;',
      '[WinInet.NativeMethods]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null;'
    ].join(' ');
    try { await this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15_000 }); }
    catch (_) { /* Registry values are already updated; notification is best effort. */ }
  }

  async enable(httpPort) {
    if (!this.supported()) throw new Error('Системный Proxy сейчас поддерживается только в Windows');
    const port = Number(httpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный локальный HTTP-порт');
    if (!fs.existsSync(this.backupPath)) {
      const backup = await this.snapshot();
      fs.writeFileSync(this.backupPath, JSON.stringify(backup, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    await this.writeValue('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`);
    await this.writeValue('ProxyOverride', 'REG_SZ', '<local>;localhost;127.*');
    await this.writeValue('ProxyEnable', 'REG_DWORD', '1');
    await this.notifyWindows();
    this.active = true;
    return { enabled: true, server: `127.0.0.1:${port}` };
  }

  async restore() {
    if (!this.supported()) { this.active = false; return { restored: false, reason: 'unsupported' }; }
    if (!fs.existsSync(this.backupPath)) { this.active = false; return { restored: false, reason: 'no-backup' }; }
    const backup = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));
    for (const name of MANAGED_VALUES) {
      const entry = backup.values?.[name];
      if (!entry?.exists) await this.deleteValue(name);
      else await this.writeValue(name, entry.type || 'REG_SZ', entry.value);
    }
    await this.notifyWindows();
    try { fs.unlinkSync(this.backupPath); } catch (_) { /* best effort */ }
    this.active = false;
    return { restored: true };
  }

  async emergencyRestore() {
    if (!this.supported()) return { restored: false, disabledLocalProxy: false };
    if (fs.existsSync(this.backupPath)) {
      const result = await this.restore();
      return { restored: Boolean(result.restored), disabledLocalProxy: false };
    }
    const server = await this.readValue('ProxyServer');
    const localRedlineProxy = server.exists && /(?:^|[;=])127\.0\.0\.1:(?:1080[89]|1081[89])(?:;|$)/i.test(server.value);
    if (localRedlineProxy) {
      await this.writeValue('ProxyEnable', 'REG_DWORD', '0');
      await this.notifyWindows();
    }
    this.active = false;
    return { restored: false, disabledLocalProxy: localRedlineProxy };
  }

  async recoverIfNeeded() {
    if (!this.supported() || !fs.existsSync(this.backupPath)) return { recovered: false };
    const result = await this.restore();
    return { recovered: Boolean(result.restored) };
  }
}

module.exports = { SystemProxyManager, parseRegOutput, REG_KEY };
