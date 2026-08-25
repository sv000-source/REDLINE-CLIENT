'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { runBypassDiagnostics } = require('./bypass-diagnostics');

const PROFILES = Object.freeze({
  general: { name: 'GENERAL', file: 'general.bat', description: 'Основной профиль YouTube + Discord' },
  alt: { name: 'ALT', file: 'general (ALT).bat', description: 'Fake + split для сложных DPI' },
  alt2: { name: 'ALT 2', file: 'general (ALT2).bat', description: 'Альтернативная пакетная стратегия' },
  fakeTls: { name: 'FAKE TLS AUTO', file: 'general (FAKE TLS AUTO).bat', description: 'Автоматический TLS fake' },
  simpleFake: { name: 'SIMPLE FAKE', file: 'general (SIMPLE FAKE).bat', description: 'Упрощённая fake-стратегия' },
  experimental: { name: 'EXPERIMENTAL', file: 'general (EXP).bat', description: 'Экспериментальный профиль Flowseal' }
});

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: 20_000, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
}

function quoteBatch(value) { return `"${String(value).replace(/"/g, '""')}"`; }

function extractStrategyCommand(batchText, binDirectory, listsDirectory) {
  const lines = String(batchText).replace(/\r/g, '').split('\n');
  const start = lines.findIndex(line => /start\s+"zapret:/i.test(line) && /winws\.exe/i.test(line));
  if (start < 0) throw new Error('В профиле не найдена команда запуска winws.exe');
  const chunks = [];
  for (let index = start; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (index === start) {
      const marker = line.search(/winws\.exe"/i);
      if (marker < 0) throw new Error('Повреждена первая строка стратегии');
      line = line.slice(marker + 'winws.exe"'.length).trim();
    }
    const continued = /\^\s*$/.test(line);
    line = line.replace(/\^\s*$/, '').trim();
    if (line) chunks.push(line);
    if (!continued) break;
  }
  let command = chunks.join(' ');
  const binSep = String(binDirectory).includes('\\') ? '\\' : path.sep;
  const listsSep = String(listsDirectory).includes('\\') ? '\\' : path.sep;
  const bin = `${binDirectory.replace(/[\\/]$/, '')}${binSep}`;
  const lists = `${listsDirectory.replace(/[\\/]$/, '')}${listsSep}`;
  command = command
    .replace(/%BIN%/gi, bin)
    .replace(/%LISTS%/gi, lists)
    .replace(/%GameFilterTCP%/gi, '12')
    .replace(/%GameFilterUDP%/gi, '12')
    .replace(/%GameFilter%/gi, '12');
  if (!command.includes('--wf-tcp') && !command.includes('--wf-udp')) throw new Error('Профиль не содержит WinDivert-фильтр');
  return command;
}

class ZapretManager {
  constructor({ assetPath, runtimeDirectory, platform = process.platform, runner = execFileAsync, onEvent = () => {} }) {
    this.assetPath = assetPath;
    this.runtimeDirectory = runtimeDirectory;
    this.platform = platform;
    this.runner = runner;
    this.onEvent = onEvent;
    this.statePath = path.join(runtimeDirectory, 'zapret-state.json');
    this.wrapperPath = path.join(runtimeDirectory, 'zapret-start.cmd');
    this.logPath = path.join(runtimeDirectory, 'zapret.log');
    this.exitPath = path.join(runtimeDirectory, 'zapret-exit.txt');
    this.current = { state: 'stopped', profileId: '', profileName: '', startedAt: '', external: false };
    fs.mkdirSync(runtimeDirectory, { recursive: true });
  }

  available() {
    return this.platform === 'win32' && fs.existsSync(path.join(this.assetPath, 'bin', 'winws.exe'));
  }

  profiles() {
    return Object.entries(PROFILES).map(([id, profile]) => ({ id, ...profile, available: fs.existsSync(path.join(this.assetPath, profile.file)) }));
  }

  emit(type, message, level = 'info', extra = {}) {
    this.onEvent({ type, message, level, at: new Date().toISOString(), status: this.publicStatus(), ...extra });
  }

  publicStatus() {
    return { available: this.available(), ...this.current, profiles: this.profiles(), version: 'Flowseal 1.10.1' };
  }

  async processRunning() {
    if (this.platform !== 'win32') return false;
    try {
      const { stdout } = await this.runner('tasklist.exe', ['/FI', 'IMAGENAME eq winws.exe', '/FO', 'CSV', '/NH']);
      return /"winws\.exe"/i.test(stdout);
    } catch (_) { return false; }
  }

  async refreshStatus() {
    const running = await this.processRunning();
    if (running) {
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch (_) { /* external process */ }
      this.current = {
        state: 'running', profileId: saved.profileId || '', profileName: saved.profileName || 'EXTERNAL WINWS',
        startedAt: saved.startedAt || '', external: !saved.profileId
      };
    } else if (this.current.state !== 'starting' && this.current.state !== 'stopping') {
      this.current = { state: 'stopped', profileId: '', profileName: '', startedAt: '', external: false };
      try { fs.unlinkSync(this.statePath); } catch (_) { /* no state */ }
    }
    return this.publicStatus();
  }

  writeWrapper(profileId) {
    const profile = PROFILES[profileId];
    if (!profile) throw new Error('Неизвестный профиль Zapret');
    const profilePath = path.join(this.assetPath, profile.file);
    if (!fs.existsSync(profilePath)) throw new Error(`Файл профиля не найден: ${profile.file}`);
    // Keep repeated strategy paths relative to avoid Windows cmd.exe's 8191-char limit.
    const command = extractStrategyCommand(fs.readFileSync(profilePath, 'utf8'), 'bin\\', 'lists\\');
    const winws = path.join(this.assetPath, 'bin', 'winws.exe');
    const content = [
      '@echo off',
      'chcp 65001 >nul',
      `cd /d ${quoteBatch(this.assetPath)}`, 
      `echo [REDLINE] profile=${profile.name} > ${quoteBatch(this.logPath)}`,
      `${quoteBatch(winws)} ${command} >> ${quoteBatch(this.logPath)} 2>&1`,
      `echo %errorlevel% > ${quoteBatch(this.exitPath)}`,
      ''
    ].join('\r\n');
    fs.writeFileSync(this.wrapperPath, content, 'utf8');
    return { profile, command };
  }

  async elevateBatch(batchPath, wait = false) {
    const escaped = batchPath.replace(/'/g, "''");
    const waitFlag = wait ? '-Wait' : '';
    const script = `$arg='/d /s /c ""${escaped}""'; Start-Process -FilePath $env:ComSpec -ArgumentList $arg -Verb RunAs -WindowStyle Hidden ${waitFlag}`;
    await this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: wait ? 30_000 : 20_000 });
  }

  async waitForRunning(timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.processRunning()) return true;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return false;
  }

  async start(profileId = 'general') {
    if (!this.available()) throw new Error('Zapret доступен только в полной Windows-сборке');
    if (await this.processRunning()) throw new Error('winws.exe уже запущен. Сначала остановите активный DPI bypass.');
    const { profile } = this.writeWrapper(profileId);
    try { fs.unlinkSync(this.exitPath); } catch (_) { /* no previous result */ }
    this.current = { state: 'starting', profileId, profileName: profile.name, startedAt: '', external: false };
    this.emit('state', 'Инициализация DPI bypass');
    this.emit('log', `TARGET MATRIX: YOUTUBE / DISCORD / GOOGLEVIDEO`, 'info');
    this.emit('log', `STRATEGY: ${profile.name}`, 'info');
    this.emit('log', 'Запрос привилегий администратора Windows', 'warn');
    try {
      await this.elevateBatch(this.wrapperPath, false);
      this.emit('log', 'UAC подтверждён. Загрузка WinDivert…', 'info');
      const running = await this.waitForRunning();
      if (!running) {
        let detail = '';
        try { detail = fs.readFileSync(this.logPath, 'utf8').trim().slice(-1200); } catch (_) { /* no log */ }
        throw new Error(detail || 'winws.exe не запустился за 15 секунд');
      }
      this.current = { state: 'running', profileId, profileName: profile.name, startedAt: new Date().toISOString(), external: false };
      fs.writeFileSync(this.statePath, JSON.stringify(this.current), { encoding: 'utf8', mode: 0o600 });
      this.emit('log', 'WinDivert filter: ACTIVE', 'info');
      this.emit('log', 'Discord UDP/STUN matrix: ARMED', 'info');
      this.emit('log', 'YouTube QUIC/TLS matrix: ARMED', 'info');
      this.emit('state', 'DPI bypass подключён');
      return this.publicStatus();
    } catch (error) {
      this.current.state = 'error';
      this.emit('log', error.message, 'error');
      this.emit('state', 'Ошибка подключения', 'error');
      throw error;
    }
  }

  async test() {
    if (!await this.processRunning()) throw new Error('DPI Shield не запущен');
    this.emit('test', 'Запуск YouTube/Discord diagnostic matrix');
    const report = await runBypassDiagnostics({
      onEvent: event => this.emit('test', event.message, event.level || 'info', { target: event.target, result: event.result })
    });
    this.emit('test', `Диагностика завершена: ${report.passed}/${report.total}`, report.ok ? 'info' : 'warn', { report });
    return report;
  }

  async stop() {
    if (this.platform !== 'win32') return this.publicStatus();
    this.current.state = 'stopping';
    this.emit('state', 'Остановка DPI bypass');
    const cleanup = path.join(this.runtimeDirectory, 'zapret-stop.cmd');
    fs.writeFileSync(cleanup, [
      '@echo off',
      'taskkill /F /T /IM winws.exe >nul 2>&1',
      'sc stop WinDivert >nul 2>&1',
      'sc delete WinDivert >nul 2>&1',
      'sc stop WinDivert1.4 >nul 2>&1',
      'sc delete WinDivert1.4 >nul 2>&1',
      ''
    ].join('\r\n'), 'utf8');
    try {
      await this.elevateBatch(cleanup, true);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && await this.processRunning()) await new Promise(resolve => setTimeout(resolve, 250));
      if (await this.processRunning()) throw new Error('Не удалось остановить winws.exe');
      this.current = { state: 'stopped', profileId: '', profileName: '', startedAt: '', external: false };
      try { fs.unlinkSync(this.statePath); } catch (_) { /* no state */ }
      this.emit('state', 'DPI bypass отключён');
      return this.publicStatus();
    } catch (error) {
      this.current.state = 'error';
      this.emit('log', error.message, 'error');
      throw error;
    }
  }
}

module.exports = { ZapretManager, PROFILES, extractStrategyCommand };
