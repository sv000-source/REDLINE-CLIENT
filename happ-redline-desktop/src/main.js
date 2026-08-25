'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, session, Tray, nativeImage, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { SecureStore } = require('./services/store');
const { SubscriptionManager, MAX_SUBSCRIPTION_BYTES } = require('./services/subscriptions');
const { pingMany } = require('./services/ping');
const { SystemProxyManager } = require('./services/system-proxy');
const { XrayManager } = require('./services/xray-manager');
const { SingBoxManager } = require('./services/singbox-manager');
const { ZapretManager } = require('./services/zapret-manager');
const { SystemControl } = require('./services/system-control');
const { createHardwareIdentity } = require('./services/hwid');
const { SecuritySettings } = require('./services/security-settings');
const { parseDeepLink, PendingDeepLinks, findDeepLinks } = require('./services/deeplink');
const { checkForUpdates, RELEASES_PAGE_BASE } = require('./services/updater');

let mainWindow;
let tray;
let subscriptions;
let systemProxy;
let xray;
let singbox;
let zapret;
let systemControl;
let securitySettings;
let windowStatePath;
let cleanupStarted = false;
let allowWindowClose = false;
let shutdownRequested = false;
const pendingDeepLinks = new PendingDeepLinks();
const deepLinkDeliveryQueue = [];
const protocolRegistration = { redline: false, happ: false }; // happ:// intentionally disabled in 1.1

function readWindowState() {
  const fallback = { width: 1360, height: 860, maximized: false };
  try {
    const value = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    return {
      width: Math.max(900, Math.min(Number(value.width) || fallback.width, 3840)),
      height: Math.max(620, Math.min(Number(value.height) || fallback.height, 2160)),
      maximized: Boolean(value.maximized)
    };
  } catch (_) { return fallback; }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  try { fs.writeFileSync(windowStatePath, JSON.stringify({ ...bounds, maximized }), 'utf8'); }
  catch (_) { /* Window size persistence is best effort. */ }
}

function registerProtocolClients() {
  try { app.removeAsDefaultProtocolClient('happ'); } catch (_) { /* Old REDLINE association may not exist. */ }
  for (const scheme of ['redline']) {
    try {
      protocolRegistration[scheme] = process.defaultApp && process.argv[1]
        ? app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])])
        : app.setAsDefaultProtocolClient(scheme);
    } catch (_) { protocolRegistration[scheme] = false; }
  }
}

function deliverDeepLinks() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
  while (deepLinkDeliveryQueue.length) {
    const item = deepLinkDeliveryQueue.shift();
    mainWindow.webContents.send(item.error ? 'deeplink:error' : 'deeplink:request', item.error || item);
  }
}

async function receiveDeepLink(raw) {
  try {
    const candidate = pendingDeepLinks.create(await parseDeepLink(raw));
    deepLinkDeliveryQueue.push(candidate);
    deliverDeepLinks();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (error) {
    const message = error?.message || 'Не удалось обработать внешнюю ссылку';
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoadingMainFrame()) {
      mainWindow.webContents.send('deeplink:error', message);
    } else {
      deepLinkDeliveryQueue.push({ error: message });
    }
  }
}

function createWindow() {
  const saved = readWindowState();
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#07080a',
    resizable: true,
    maximizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: process.argv.includes('--dev')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', deliverDeepLinks);
  mainWindow.once('ready-to-show', () => {
    mainWindow.setFullScreen(true);
    mainWindow.show();
  });
  mainWindow.on('close', event => {
    saveWindowState();
    if (allowWindowClose || cleanupStarted) return;
    event.preventDefault();
    if (!shutdownRequested) {
      shutdownRequested = true;
      mainWindow.webContents.send('app:shutdown-request');
      setTimeout(() => {
        if (!allowWindowClose && mainWindow && !mainWindow.isDestroyed()) {
          allowWindowClose = true;
          mainWindow.close();
        }
      }, 7000);
    }
  });
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    const key = input.key.toLowerCase();
    const current = mainWindow.webContents.getZoomFactor();
    if (key === '+' || key === '=') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(Math.min(1.5, current + 0.1));
    } else if (key === '-') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(Math.max(0.75, current - 0.1));
    } else if (key === '0') {
      event.preventDefault();
      mainWindow.webContents.setZoomFactor(1);
    }
  });
}

function execSafe(file, args, timeout = 12_000) {
  return new Promise(resolve => execFile(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => resolve({ ok: !error, error: error?.message || '', stdout: String(stdout || ''), stderr: String(stderr || '') })));
}

async function performEmergencyReset() {
  const report = [];
  for (const [name, manager] of [['Xray', xray], ['Sing-box', singbox], ['DPI Shield', zapret]]) {
    try { await manager?.stop(); report.push(`${name}: stopped`); } catch (error) { report.push(`${name}: ${error.message}`); }
  }
  try {
    const proxy = await systemProxy.emergencyRestore();
    report.push(proxy.restored ? 'System Proxy: previous settings restored' : proxy.disabledLocalProxy ? 'System Proxy: local REDLINE proxy disabled' : 'System Proxy: no REDLINE override found');
  } catch (error) { report.push(`System Proxy: ${error.message}`); }
  if (process.platform === 'win32') {
    await execSafe('taskkill.exe', ['/F', '/T', '/IM', 'sing-box.exe']);
    await execSafe('taskkill.exe', ['/F', '/T', '/IM', 'xray.exe']);
    await execSafe('taskkill.exe', ['/F', '/T', '/IM', 'winws.exe']);
    await execSafe('sc.exe', ['stop', 'WinDivert']); await execSafe('sc.exe', ['delete', 'WinDivert']);
    await execSafe('sc.exe', ['stop', 'WinDivert1.4']); await execSafe('sc.exe', ['delete', 'WinDivert1.4']);
    const dns = await execSafe('ipconfig.exe', ['/flushdns']); report.push(dns.ok ? 'DNS cache: flushed' : 'DNS cache: flush failed');
  }
  const runtime = path.join(app.getPath('userData'), 'runtime');
  for (const file of ['xray-runtime.json', 'sing-box-tun.json', 'zapret-start.cmd', 'zapret-stop.cmd', 'zapret-state.json']) {
    try { fs.unlinkSync(path.join(runtime, file)); } catch (_) {}
  }
  report.push('Subscriptions and personal notes: preserved');
  return { ok: true, report, completedAt: new Date().toISOString() };
}

function loadTrayImage() {
  for (const file of ['icon.ico', 'icon-32.png']) {
    try {
      const image = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
      if (!image.isEmpty()) return image;
    } catch (_) { /* пробуем следующий файл */ }
  }
  return nativeImage.createEmpty();
}

function showWindowFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openReleasePage(url) {
  // Открываем только страницы релизов собственного репозитория —
  // произвольные внешние ссылки из данных релиза не запускаем.
  const candidate = String(url || '');
  const parsed = new URL(candidate);
  const allowed = parsed.protocol === 'https:'
    && parsed.hostname.toLowerCase() === 'github.com'
    && parsed.pathname.toLowerCase().startsWith('/sv000-source/redline-client/releases');
  if (!allowed) throw new Error('Можно открыть только страницу релизов REDLINE');
  return shell.openExternal(candidate);
}

async function runUpdateCheck({ notify = false } = {}) {
  const currentVersion = app.getVersion();
  let status;
  try {
    status = await checkForUpdates({ currentVersion, fetchFn: globalThis.fetch });
  } catch (error) {
    status = { ok: false, checked: false, current: currentVersion, error: error?.message || 'Проверка не выполнена' };
  }
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(status.ok && status.updateAvailable
      ? `REDLINE Client ${currentVersion} — доступна ${status.latest.version}`
      : `REDLINE Client ${currentVersion}`);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:status', status);
  if (status.ok && status.updateAvailable && status.latest && notify && mainWindow && !mainWindow.isDestroyed()) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'REDLINE Client — обновление',
      message: `Доступна версия ${status.latest.version}`,
      detail: `Сейчас установлена: ${status.current}. Релиз публикуется на GitHub — перед установкой сверьте SHA-256 из описания релиза.`,
      buttons: ['Открыть релиз', 'Позже'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) openReleasePage(status.latest.htmlUrl || RELEASES_PAGE_BASE).catch(() => {});
  }
  return status;
}

function createTray() {
  try {
    tray = new Tray(loadTrayImage());
  } catch (_) {
    tray = null;
    return; // трей — best effort: приложение работает без него
  }
  tray.setToolTip(`REDLINE Client ${app.getVersion()}`);
  const menu = Menu.buildFromTemplate([
    { label: 'Показать REDLINE Client', click: showWindowFromTray },
    { type: 'separator' },
    { label: 'Проверить обновления', click: () => { runUpdateCheck({ notify: true }); } },
    { label: 'GitHub Releases', click: () => { openReleasePage(RELEASES_PAGE_BASE).catch(() => {}); } },
    { type: 'separator' },
    { label: 'Выход', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); else app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showWindowFromTray);
}

function result(handler) {
  return async (_event, payload) => {
    try { return { ok: true, data: await handler(payload) }; }
    catch (error) { return { ok: false, error: error?.message || 'Неизвестная ошибка' }; }
  };
}

function registerIpc() {
  ipcMain.handle('app:info', result(async () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    encryptedStorage: subscriptions.snapshot().security.encrypted,
    xray: await xray.version(),
    singbox: await singbox.version(),
    zapret: await zapret.refreshStatus(),
    system: systemControl.info(),
    protocols: { ...protocolRegistration }
  })));
  ipcMain.handle('security:status', result(async () => ({ ...securitySettings.status(), system: systemControl.info() })));
  ipcMain.handle('security:accept-agreement', result(async () => securitySettings.acceptAgreement()));
  ipcMain.handle('security:complete-onboarding', result(async () => securitySettings.completeOnboarding()));
  ipcMain.handle('security:reset-onboarding', result(async () => securitySettings.resetOnboarding()));
  ipcMain.handle('security:verify', result(async payload => securitySettings.verify(payload?.password)));
  ipcMain.handle('security:set-password', result(async payload => {
    if (securitySettings.status().required && !securitySettings.status().unlocked) throw new Error('Сначала разблокируйте REDLINE');
    return securitySettings.setPassword(payload?.password);
  }));
  ipcMain.handle('security:remove-password', result(async () => {
    if (securitySettings.status().required && !securitySettings.status().unlocked) throw new Error('Сначала разблокируйте REDLINE');
    return securitySettings.removePassword();
  }));
  ipcMain.handle('app:confirm-close', () => {
    allowWindowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('system:power', result(async payload => { await systemControl.power(payload?.action); return { accepted: true }; }));
  ipcMain.handle('network:emergency-reset', result(async () => performEmergencyReset()));
  ipcMain.handle('system:autostart-status', result(async () => systemControl.autostartStatus()));
  ipcMain.handle('system:set-autostart', result(async payload => systemControl.setAutostart(Boolean(payload?.enabled))));
  ipcMain.handle('window:exit-fullscreen', () => { mainWindow?.setFullScreen(false); mainWindow?.maximize(); return false; });
  ipcMain.handle('window:enter-fullscreen', () => { mainWindow?.setFullScreen(true); return true; });
  ipcMain.handle('window:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:zoom', (_event, action) => {
    if (!mainWindow) return 100;
    const current = mainWindow.webContents.getZoomFactor();
    const next = action === 'in' ? Math.min(1.5, current + 0.1)
      : action === 'out' ? Math.max(0.75, current - 0.1)
      : 1;
    mainWindow.webContents.setZoomFactor(next);
    return Math.round(next * 100);
  });

  ipcMain.handle('subscriptions:list', result(async () => subscriptions.snapshot()));
  ipcMain.handle('subscriptions:add-url', result(payload => subscriptions.addFromUrl(payload || {})));
  ipcMain.handle('subscriptions:add-content', result(payload => subscriptions.addFromContent(payload || {})));
  ipcMain.handle('subscriptions:update', result(payload => subscriptions.update(payload?.id)));
  ipcMain.handle('subscriptions:update-all', result(() => subscriptions.updateAll()));
  ipcMain.handle('subscriptions:remove', result(payload => subscriptions.remove(payload?.id)));
  ipcMain.handle('subscriptions:set-hwid', result(payload => subscriptions.setHwid(payload?.id, payload?.enabled)));

  ipcMain.handle('deeplink:accept', result(async payload => {
    const item = pendingDeepLinks.take(payload?.token);
    const overrideName = String(payload?.name || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 100);
    const name = overrideName || item.name;
    if (item.kind === 'url') return subscriptions.addFromUrl({ name, url: item.payload, autoUpdate: true });
    return subscriptions.addFromContent({ name, content: item.payload, sourceType: 'deeplink', sourceHost: item.sourceHost || 'external link' });
  }));
  ipcMain.handle('deeplink:reject', result(async payload => ({ rejected: pendingDeepLinks.reject(payload?.token) })));

  ipcMain.handle('subscriptions:import-file', result(async payload => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Импортировать подписку или конфигурацию',
      properties: ['openFile'],
      filters: [
        { name: 'Подписки и конфигурации', extensions: ['txt', 'json', 'conf', 'happ'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const filePath = picked.filePaths[0];
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SUBSCRIPTION_BYTES) throw new Error('Файл больше допустимых 5 МБ');
    const content = fs.readFileSync(filePath, 'utf8');
    const imported = subscriptions.addFromContent({
      name: path.basename(filePath, path.extname(filePath)),
      content,
      note: payload?.note || '',
      sourceType: 'file',
      sourceHost: path.basename(filePath)
    });
    return { canceled: false, ...imported };
  }));

  ipcMain.handle('nodes:ping', result(async payload => {
    const ids = Array.isArray(payload?.ids) ? payload.ids.slice(0, 500) : [];
    const servers = ids.length ? subscriptions.getServersByIds(ids) : subscriptions.allServers().slice(0, 500);
    if (!servers.length) throw new Error('Нет узлов для проверки');
    return pingMany(servers, { concurrency: 8, timeout: payload?.timeout || 3500 });
  }));

  ipcMain.handle('xray:status', result(async () => ({ ...xray.publicStatus(), core: await xray.version() })));
  ipcMain.handle('xray:start', result(async payload => {
    if (singbox.publicStatus().state === 'running') throw new Error('Сначала остановите Sing-box TUN');
    const zapretStatus = await zapret.refreshStatus();
    if (zapretStatus.state === 'running') throw new Error('Сначала остановите DPI bypass');
    const server = subscriptions.getServerById(payload?.serverId);
    if (!server) throw new Error('Выбранный узел не найден');
    return xray.start(server, {
      systemProxy: payload?.systemProxy !== false,
      socksPort: payload?.socksPort || 10808,
      httpPort: payload?.httpPort || 10809,
      loglevel: payload?.loglevel || 'warning'
    });
  }));
  ipcMain.handle('xray:stop', result(async () => xray.stop()));

  ipcMain.handle('singbox:status', result(async () => ({ ...singbox.publicStatus(), core: await singbox.version() })));
  ipcMain.handle('singbox:start', result(async payload => {
    if (xray.publicStatus().state === 'running') throw new Error('Сначала остановите Xray Proxy');
    const zapretStatus = await zapret.refreshStatus();
    if (zapretStatus.state === 'running') throw new Error('Сначала остановите DPI Shield');
    const server = subscriptions.getServerById(payload?.serverId);
    if (!server) throw new Error('Выбранный узел не найден');
    return singbox.start(server, { mixedPort: payload?.mixedPort || 10818, mtu: payload?.mtu || 9000, stack: payload?.stack || 'mixed' });
  }));
  ipcMain.handle('singbox:stop', result(async () => singbox.stop()));

  ipcMain.handle('updater:check', result(async () => runUpdateCheck({ notify: true })));
  ipcMain.handle('updater:open-release', result(async payload => { await openReleasePage(payload?.url); return { opened: true }; }));

  ipcMain.handle('zapret:status', result(async () => zapret.refreshStatus()));
  ipcMain.handle('zapret:start', result(async payload => {
    if (xray.publicStatus().state === 'running') throw new Error('Сначала остановите Xray Proxy');
    if (singbox.publicStatus().state === 'running') throw new Error('Сначала остановите Sing-box TUN');
    return zapret.start(payload?.profileId || 'general');
  }));
  ipcMain.handle('zapret:stop', result(async () => zapret.stop()));
  ipcMain.handle('zapret:test', result(async () => zapret.test()));
}

function resolveSingBoxPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'sing-box', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box')
    : path.join(__dirname, '..', 'vendor', 'sing-box', process.platform === 'win32' ? 'windows-x64' : 'linux-x64', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
}

function resolveZapretPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'zapret')
    : path.join(__dirname, '..', 'vendor', 'zapret', 'windows-x64');
}

function resolveXrayPaths() {
  if (app.isPackaged) {
    return {
      corePath: path.join(process.resourcesPath, 'xray', process.platform === 'win32' ? 'xray.exe' : 'xray'),
      legacyCorePath: path.join(process.resourcesPath, 'xray', process.platform === 'win32' ? 'xray-legacy.exe' : 'xray-legacy'),
      assetPath: path.join(process.resourcesPath, 'xray')
    };
  }
  const platformFolder = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  return {
    corePath: path.join(__dirname, '..', 'vendor', 'xray', platformFolder, process.platform === 'win32' ? 'xray.exe' : 'xray'),
    legacyCorePath: path.join(__dirname, '..', 'vendor', 'xray', platformFolder, process.platform === 'win32' ? 'xray-legacy.exe' : 'xray-legacy'),
    assetPath: path.join(__dirname, '..', 'vendor', 'xray', platformFolder)
  };
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  registerProtocolClients();
  for (const link of findDeepLinks(process.argv)) receiveDeepLink(link);

  app.on('second-instance', (_event, commandLine) => {
    for (const link of findDeepLinks(commandLine)) receiveDeepLink(link);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveDeepLink(url);
  });

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    windowStatePath = path.join(userData, 'window-state.json');
    const store = new SecureStore({ directory: userData, safeStorage });
    securitySettings = new SecuritySettings({ directory: userData, safeStorage });
    const deviceIdentity = await createHardwareIdentity({ locale: app.getLocale() || 'ru-RU' });
    subscriptions = new SubscriptionManager(store, { deviceIdentity });
    systemProxy = new SystemProxyManager({ directory: userData });
    const recovery = await systemProxy.recoverIfNeeded();
    const paths = resolveXrayPaths();
    xray = new XrayManager({
      ...paths,
      runtimeDirectory: path.join(userData, 'runtime'),
      systemProxy,
      onEvent: event => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('xray:event', event);
      }
    });
    singbox = new SingBoxManager({
      binaryPath: resolveSingBoxPath(),
      runtimeDirectory: path.join(userData, 'runtime'),
      onEvent: event => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('singbox:event', event);
      }
    });
    zapret = new ZapretManager({
      assetPath: resolveZapretPath(),
      runtimeDirectory: path.join(userData, 'runtime'),
      onEvent: event => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zapret:event', event);
      }
    });
    systemControl = new SystemControl({ executablePath: process.execPath });
    await zapret.refreshStatus();
    registerIpc();

    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    createWindow();
    createTray();
    // Фоновая проверка обновлений после запуска: без диалога, только
    // статус в трей-иконке и строке настроек. Ручная проверка — кнопка
    // «Проверить» в настройках или пункт меню трея.
    setTimeout(() => { runUpdateCheck({ notify: false }); }, 3000);
    if (recovery.recovered) {
      mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('xray:event', {
        type: 'log', level: 'warn', message: 'Восстановлены системные настройки Proxy после предыдущего аварийного завершения', at: new Date().toISOString(), status: xray.publicStatus()
      }));
    }
  }).catch(error => {
    dialog.showErrorBox('REDLINE Client', error.message);
    app.quit();
  });
}

app.on('before-quit', event => {
  if (cleanupStarted || !xray) return;
  cleanupStarted = true;
  event.preventDefault();
  Promise.race([
    Promise.allSettled([xray.stop(), singbox?.stop()]),
    new Promise(resolve => setTimeout(resolve, 7000))
  ]).finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
