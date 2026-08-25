'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { buildXrayConfig } = require('./xray-config');

function linkRequiresLegacyCore(raw) {
  const value = String(raw || '').trim();
  if (!value) return false;
  if (/^(vless|trojan|hysteria2|hy2|socks5?):\/\//i.test(value)) {
    try {
      const params = new URL(value).searchParams;
      const insecure = params.get('insecure') || params.get('allowInsecure') || '';
      const hasPin = params.get('pinSHA256') || params.get('pcs') || params.get('pinnedPeerCertSha256');
      return !hasPin && ['1', 'true', 'yes', 'on'].includes(insecure.toLowerCase());
    } catch (_) { return /[?&](?:insecure|allowInsecure)=(?:1|true|yes|on)/i.test(value); }
  }
  if (/^vmess:\/\//i.test(value)) {
    try {
      let payload = value.slice('vmess://'.length).split('#')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      return Boolean(data.allowInsecure === true || data.allowInsecure === 1 || String(data.allowInsecure).toLowerCase() === 'true');
    } catch (_) { return false; }
  }
  return false;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 15_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' && preferred) resolve(freePort(0));
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port: preferred || 0 }, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeout = 6000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Xray не открыл локальный порт ${port}`));
        else setTimeout(attempt, 120);
      });
      socket.setTimeout(500, () => socket.destroy());
    };
    attempt();
  });
}

class XrayManager {
  constructor({ corePath, legacyCorePath = '', assetPath, runtimeDirectory, systemProxy, onEvent = () => {} }) {
    this.corePath = corePath;
    this.legacyCorePath = legacyCorePath;
    this.activeCorePath = corePath;
    this.assetPath = assetPath;
    this.runtimeDirectory = runtimeDirectory;
    this.systemProxy = systemProxy;
    this.onEvent = onEvent;
    this.child = null;
    this.current = null;
    this.stopping = false;
    this.configPath = path.join(runtimeDirectory, 'xray-runtime.json');
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    try { fs.unlinkSync(this.configPath); } catch (_) { /* Remove stale plaintext config from a previous crash. */ }
  }

  available() { return fs.existsSync(this.corePath); }

  publicStatus() {
    return {
      available: this.available(),
      state: this.current?.state || 'stopped',
      serverId: this.current?.serverId || '',
      serverName: this.current?.serverName || '',
      socksPort: this.current?.socksPort || null,
      httpPort: this.current?.httpPort || null,
      systemProxy: Boolean(this.current?.systemProxy),
      coreMode: this.current?.coreMode || 'modern',
      startedAt: this.current?.startedAt || ''
    };
  }

  emit(type, payload = {}) {
    this.onEvent({ type, at: new Date().toISOString(), ...payload, status: this.publicStatus() });
  }

  async version() {
    if (!this.available()) return { available: false, version: '' };
    try {
      const { stdout } = await execFileAsync(this.corePath, ['version'], { env: this.environment() });
      const first = stdout.split(/\r?\n/)[0] || '';
      const match = first.match(/^Xray\s+([^\s]+)/i);
      let compatibilityVersion = '';
      if (this.legacyCorePath && fs.existsSync(this.legacyCorePath)) {
        try {
          const legacy = await execFileAsync(this.legacyCorePath, ['version'], { env: this.environment() });
          compatibilityVersion = legacy.stdout.split(/\r?\n/)[0].match(/^Xray\s+([^\s]+)/i)?.[1] || '';
        } catch (_) { /* optional compatibility core */ }
      }
      return { available: true, version: match?.[1] || first.trim(), compatibilityVersion, compatibilityAvailable: Boolean(compatibilityVersion) };
    } catch (error) {
      return { available: false, version: '', error: error.message };
    }
  }

  environment() {
    return { ...process.env, XRAY_LOCATION_ASSET: this.assetPath };
  }

  async validateConfig() {
    try {
      await execFileAsync(this.activeCorePath, ['run', '-test', '-c', this.configPath], { env: this.environment() });
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message).trim().split(/\r?\n/).slice(-4).join(' ');
      throw new Error(`Xray отклонил конфигурацию: ${detail}`);
    }
  }

  consumeLog(stream, level) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) this.emit('log', { level, message: line.trim().slice(0, 1200) });
    });
  }

  async start(server, options = {}) {
    if (!this.available()) throw new Error('Файл Xray Core не найден в сборке');
    if (this.child) await this.stop();
    const useLegacyCore = linkRequiresLegacyCore(server?.raw);
    if (useLegacyCore && (!this.legacyCorePath || !fs.existsSync(this.legacyCorePath))) throw new Error('Для узла с insecure=1 выберите TUN CORE: Sing-box поддерживает такой TLS, а Xray 26.7.28 удалил allowInsecure');
    this.activeCorePath = useLegacyCore ? this.legacyCorePath : this.corePath;
    const socksPort = await freePort(Number(options.socksPort) || 10808);
    const httpPort = await freePort(Number(options.httpPort) || (socksPort === 10809 ? 10810 : 10809));
    const config = buildXrayConfig(server, { socks: socksPort, http: httpPort }, { loglevel: options.loglevel || 'warning', bypassPrivate: options.bypassPrivate });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });

    this.current = {
      state: 'starting', serverId: server.id, serverName: server.name,
      socksPort, httpPort, systemProxy: false, coreMode: useLegacyCore ? 'compat-insecure' : 'modern', startedAt: new Date().toISOString()
    };
    this.emit('state', { message: useLegacyCore ? 'Проверка конфигурации Xray compatibility core v26.1.23 (insecure TLS)' : 'Проверка конфигурации Xray v26.7.28' });

    try {
      await this.validateConfig();
      this.child = spawn(this.activeCorePath, ['run', '-c', this.configPath], {
        cwd: this.assetPath,
        env: this.environment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.consumeLog(this.child.stdout, 'info');
      this.consumeLog(this.child.stderr, 'warn');
      this.child.once('error', error => this.emit('log', { level: 'error', message: error.message }));
      this.child.once('exit', (code, signal) => this.handleExit(code, signal));

      await Promise.all([waitForPort(socksPort), waitForPort(httpPort)]);
      if (options.systemProxy !== false) {
        await this.systemProxy.enable(httpPort);
        this.current.systemProxy = true;
      }
      this.current.state = 'running';
      this.emit('state', { message: 'Xray запущен' });
      return this.publicStatus();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async handleExit(code, signal) {
    const wasStopping = this.stopping;
    this.child = null;
    if (!this.current) return;
    if (!wasStopping) {
      this.emit('log', { level: 'error', message: `Xray неожиданно завершился: code=${code ?? 'null'} signal=${signal || 'none'}` });
      try { await this.systemProxy.restore(); } catch (error) { this.emit('log', { level: 'error', message: `Не удалось восстановить системный Proxy: ${error.message}` }); }
      try { fs.unlinkSync(this.configPath); } catch (_) { /* best effort */ }
      this.current.state = 'error';
      this.current.systemProxy = false;
      this.emit('state', { message: 'Xray остановлен с ошибкой' });
    }
  }

  async terminateChild() {
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      try { child.kill(); } catch (_) { finish(); }
      setTimeout(async () => {
        if (done) return;
        if (process.platform === 'win32') {
          try { await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 8000 }); } catch (_) { /* best effort */ }
        } else {
          try { child.kill('SIGKILL'); } catch (_) { /* best effort */ }
        }
        finish();
      }, 1800);
    });
    this.child = null;
  }

  async stop() {
    if (this.stopping) return this.publicStatus();
    this.stopping = true;
    try {
      if (this.current) this.current.state = 'stopping';
      this.emit('state', { message: 'Остановка Xray' });
      try { await this.systemProxy.restore(); }
      catch (error) { this.emit('log', { level: 'error', message: `Не удалось восстановить системный Proxy: ${error.message}` }); }
      await this.terminateChild();
      this.current = null;
      try { fs.unlinkSync(this.configPath); } catch (_) { /* deleted or never created */ }
      this.emit('state', { message: 'Xray остановлен' });
      return this.publicStatus();
    } finally {
      this.stopping = false;
    }
  }
}

module.exports = { XrayManager, freePort, waitForPort, linkRequiresLegacyCore };
