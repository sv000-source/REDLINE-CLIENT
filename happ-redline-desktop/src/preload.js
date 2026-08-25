'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, payload) {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result?.ok) throw new Error(result?.error || 'Ошибка IPC');
  return result.data;
}

contextBridge.exposeInMainWorld('redline', Object.freeze({
  isDesktop: true,
  appInfo: () => invoke('app:info'),
  appLifecycle: Object.freeze({
    confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
    onShutdownRequest: callback => {
      const listener = () => callback();
      ipcRenderer.on('app:shutdown-request', listener);
      return () => ipcRenderer.removeListener('app:shutdown-request', listener);
    }
  }),
  security: Object.freeze({
    status: () => invoke('security:status'),
    acceptAgreement: () => invoke('security:accept-agreement'),
    completeOnboarding: () => invoke('security:complete-onboarding'),
    resetOnboarding: () => invoke('security:reset-onboarding'),
    verify: password => invoke('security:verify', { password }),
    setPassword: password => invoke('security:set-password', { password }),
    removePassword: () => invoke('security:remove-password')
  }),
  system: Object.freeze({
    power: action => invoke('system:power', { action }),
    emergencyReset: () => invoke('network:emergency-reset'),
    autostartStatus: () => invoke('system:autostart-status'),
    setAutostart: enabled => invoke('system:set-autostart', { enabled })
  }),
  subscriptions: Object.freeze({
    list: () => invoke('subscriptions:list'),
    addUrl: payload => invoke('subscriptions:add-url', payload),
    addContent: payload => invoke('subscriptions:add-content', payload),
    importFile: payload => invoke('subscriptions:import-file', payload || {}),
    update: id => invoke('subscriptions:update', { id }),
    updateAll: () => invoke('subscriptions:update-all'),
    remove: id => invoke('subscriptions:remove', { id }),
    setHwid: (id, enabled) => invoke('subscriptions:set-hwid', { id, enabled })
  }),
  deepLinks: Object.freeze({
    accept: (token, name) => invoke('deeplink:accept', { token, name }),
    reject: token => invoke('deeplink:reject', { token }),
    onRequest: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('deeplink:request', listener);
      return () => ipcRenderer.removeListener('deeplink:request', listener);
    },
    onError: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('deeplink:error', listener);
      return () => ipcRenderer.removeListener('deeplink:error', listener);
    }
  }),
  nodes: Object.freeze({
    ping: (ids, timeout = 3500) => invoke('nodes:ping', { ids, timeout })
  }),
  singbox: Object.freeze({
    status: () => invoke('singbox:status'),
    start: payload => invoke('singbox:start', payload),
    stop: () => invoke('singbox:stop'),
    onEvent: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('singbox:event', listener);
      return () => ipcRenderer.removeListener('singbox:event', listener);
    }
  }),
  zapret: Object.freeze({
    status: () => invoke('zapret:status'),
    start: profileId => invoke('zapret:start', { profileId }),
    stop: () => invoke('zapret:stop'),
    test: () => invoke('zapret:test'),
    onEvent: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('zapret:event', listener);
      return () => ipcRenderer.removeListener('zapret:event', listener);
    }
  }),
  xray: Object.freeze({
    status: () => invoke('xray:status'),
    start: payload => invoke('xray:start', payload),
    stop: () => invoke('xray:stop'),
    onEvent: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('xray:event', listener);
      return () => ipcRenderer.removeListener('xray:event', listener);
    }
  }),
  updater: Object.freeze({
    check: () => invoke('updater:check'),
    openRelease: url => invoke('updater:open-release', { url }),
    onStatus: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    }
  }),
  window: Object.freeze({
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    zoom: action => ipcRenderer.invoke('window:zoom', action),
    exitFullscreen: () => ipcRenderer.invoke('window:exit-fullscreen'),
    enterFullscreen: () => ipcRenderer.invoke('window:enter-fullscreen'),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    onMaximized: callback => {
      const listener = (_event, value) => callback(Boolean(value));
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    }
  })
}));
