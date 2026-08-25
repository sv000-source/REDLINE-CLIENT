'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { buildSingBoxConfig } = require('./singbox-config');

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 20_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.unref();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(freePort(0)) : reject(error));
    server.listen({ host: '127.0.0.1', port: preferred || 0 }, () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

function waitForPort(port, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); if (Date.now() >= deadline) reject(new Error(`Sing-box не открыл mixed port ${port}`)); else setTimeout(attempt, 150); });
      socket.setTimeout(600, () => socket.destroy());
    }; attempt();
  });
}

class SingBoxManager {
  constructor({ binaryPath, runtimeDirectory, onEvent = () => {} }) {
    this.binaryPath = binaryPath;
    this.runtimeDirectory = runtimeDirectory;
    this.onEvent = onEvent;
    this.child = null;
    this.current = null;
    this.stopping = false;
    this.configPath = path.join(runtimeDirectory, 'sing-box-tun.json');
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    try { fs.unlinkSync(this.configPath); } catch (_) { /* stale config */ }
  }

  available() { return fs.existsSync(this.binaryPath); }
  publicStatus() {
    return {
      available: this.available(), state: this.current?.state || 'stopped', serverId: this.current?.serverId || '', serverName: this.current?.serverName || '',
      mixedPort: this.current?.mixedPort || null, interfaceName: this.current?.interfaceName || 'REDLINE-TUN', startedAt: this.current?.startedAt || ''
    };
  }
  emit(type, message, level = 'info') { this.onEvent({ type, message, level, at: new Date().toISOString(), status: this.publicStatus() }); }

  async version() {
    if (!this.available()) return { available: false, version: '' };
    try { const { stdout } = await execFileAsync(this.binaryPath, ['version']); return { available: true, version: stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || '' }; }
    catch (error) { return { available: false, version: '', error: error.message }; }
  }

  consume(stream, level) {
    let buffer = ''; stream.setEncoding('utf8');
    stream.on('data', chunk => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) if (line.trim()) this.emit('log', line.trim().slice(0, 1200), level); });
  }

  async start(server, options = {}) {
    if (!this.available()) throw new Error('Sing-box TUN core отсутствует в сборке');
    if (this.child) await this.stop();
    const mixedPort = await freePort(Number(options.mixedPort) || 10818);
    const config = buildSingBoxConfig(server, { mixedPort, mtu: options.mtu || 9000, stack: options.stack || 'mixed', logLevel: options.logLevel || 'warn' });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.current = { state: 'starting', serverId: server.id, serverName: server.name, mixedPort, interfaceName: 'REDLINE-TUN', startedAt: new Date().toISOString() };
    this.emit('state', 'Проверка Sing-box TUN конфигурации');
    try {
      await execFileAsync(this.binaryPath, ['check', '-c', this.configPath]);
      this.emit('log', 'TUN config accepted · auto_route=true · strict_route=true', 'info');
      this.child = spawn(this.binaryPath, ['run', '-c', this.configPath], { cwd: path.dirname(this.binaryPath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.consume(this.child.stdout, 'info'); this.consume(this.child.stderr, 'warn');
      this.child.once('error', error => this.emit('log', error.message, 'error'));
      this.child.once('exit', (code, signal) => this.handleExit(code, signal));
      await waitForPort(mixedPort);
      this.current.state = 'running';
      this.emit('state', 'Sing-box TUN подключён');
      return this.publicStatus();
    } catch (error) { await this.stop(); const detail = String(error.stderr || error.stdout || error.message).trim().split(/\r?\n/).slice(-5).join(' '); throw new Error(`Sing-box не запущен: ${detail}`); }
  }

  async handleExit(code, signal) {
    if (this.stopping) return;
    this.child = null;
    if (this.current) {
      this.current.state = 'error';
      this.emit('log', `Sing-box завершился: code=${code ?? 'null'} signal=${signal || 'none'}`, 'error');
      this.emit('state', 'TUN остановлен с ошибкой', 'error');
    }
    try { fs.unlinkSync(this.configPath); } catch (_) { /* best effort */ }
  }

  async stop() {
    if (this.stopping) return this.publicStatus();
    this.stopping = true;
    try {
      if (this.current) this.current.state = 'stopping';
      this.emit('state', 'Остановка Sing-box TUN');
      const child = this.child;
      if (child) {
        await new Promise(resolve => {
          let done = false; const finish = () => { if (!done) { done = true; resolve(); } };
          child.once('exit', finish); try { child.kill(); } catch (_) { finish(); }
          setTimeout(async () => {
            if (done) return;
            if (process.platform === 'win32') { try { await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']); } catch (_) {} }
            else { try { child.kill('SIGKILL'); } catch (_) {} }
            finish();
          }, 2500);
        });
      }
      this.child = null; this.current = null;
      try { fs.unlinkSync(this.configPath); } catch (_) {}
      this.emit('state', 'Sing-box TUN остановлен');
      return this.publicStatus();
    } finally { this.stopping = false; }
  }
}

module.exports = { SingBoxManager, freePort, waitForPort };
