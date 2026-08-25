'use strict';

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

function windowsLabel(release = os.release()) {
  const build = Number(String(release).split('.')[2] || 0);
  return build >= 22000 ? 'Windows 11' : 'Windows 10';
}

class SystemControl {
  constructor({ platform = process.platform, runner = execFileAsync, executablePath = process.execPath }) {
    this.platform = platform;
    this.runner = runner;
    this.executablePath = executablePath;
  }

  info() {
    return { platform: this.platform, arch: os.arch(), release: os.release(), label: this.platform === 'win32' ? windowsLabel() : os.type(), hostname: os.hostname() };
  }

  async power(action) {
    if (this.platform !== 'win32') throw new Error('Управление питанием доступно только в Windows');
    if (action === 'shutdown') return this.runner('shutdown.exe', ['/s', '/t', '0']);
    if (action === 'restart') return this.runner('shutdown.exe', ['/r', '/t', '0']);
    if (action === 'sleep') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend,$false,$false)';
      return this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    }
    throw new Error('Неизвестная команда питания');
  }

  async autostartStatus() {
    if (this.platform !== 'win32') return { enabled: false, supported: false };
    try { await this.runner('schtasks.exe', ['/Query', '/TN', 'REDLINE Client Autostart']); return { enabled: true, supported: true }; }
    catch (_) { return { enabled: false, supported: true }; }
  }

  async setAutostart(enabled) {
    if (this.platform !== 'win32') throw new Error('Автозапуск доступен только в Windows');
    if (enabled) await this.runner('schtasks.exe', ['/Create', '/TN', 'REDLINE Client Autostart', '/TR', `"${this.executablePath}"`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
    else { try { await this.runner('schtasks.exe', ['/Delete', '/TN', 'REDLINE Client Autostart', '/F']); } catch (_) {} }
    return this.autostartStatus();
  }
}

module.exports = { SystemControl, windowsLabel };
