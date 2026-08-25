'use strict';

const crypto = require('node:crypto');
const { parseSubscriptionContent } = require('./parser');
const { requestHeaders } = require('./hwid');

const MAX_SUBSCRIPTION_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function validateHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch (_) { throw new Error('Некорректная ссылка подписки'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Для удалённой подписки разрешены только HTTP и HTTPS');
  if (url.username || url.password) throw new Error('Логин и пароль в адресе URL не поддерживаются');
  return url.toString();
}

function safeName(value, fallback = 'Моя подписка') {
  const name = String(value || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 100);
  return name || fallback;
}

function safeNote(value) {
  return String(value || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 500);
}

async function readLimitedBody(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SUBSCRIPTION_BYTES) throw new Error('Подписка больше допустимых 5 МБ');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SUBSCRIPTION_BYTES) {
      await reader.cancel();
      throw new Error('Подписка больше допустимых 5 МБ');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

async function fetchSubscription(urlValue, options = {}) {
  const url = validateHttpUrl(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {
      'accept': 'text/plain, application/json, application/octet-stream;q=0.9, */*;q=0.5',
      ...(options.hwidEnabled ? requestHeaders(options.deviceIdentity) : { 'user-agent': 'REDLINE-Client/1.9.0-beta (Windows x64)' })
    };
    const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers });
    if (!response.ok) throw new Error(`Сервер подписки ответил HTTP ${response.status}`);
    return await readLimitedBody(response);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Превышено время ожидания подписки');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function publicServer(server, subscriptionId, subscriptionName) {
  return {
    id: server.id,
    subscriptionId,
    subscriptionName,
    name: server.name,
    protocol: server.protocol,
    host: server.host,
    port: server.port,
    transport: server.transport,
    security: server.security,
    sni: server.sni
  };
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    sourceType: subscription.sourceType,
    sourceHost: subscription.sourceHost || '',
    note: subscription.note || '',
    hasRemoteUrl: Boolean(subscription.url),
    autoUpdate: Boolean(subscription.autoUpdate),
    hwidEnabled: Boolean(subscription.hwidEnabled),
    createdAt: subscription.createdAt,
    lastUpdated: subscription.lastUpdated,
    updateError: subscription.updateError || '',
    parseWarnings: subscription.parseWarnings || 0,
    serverCount: subscription.servers.length,
    servers: subscription.servers.map(server => publicServer(server, subscription.id, subscription.name))
  };
}

class SubscriptionManager {
  constructor(store, options = {}) {
    this.store = store;
    this.state = store.read();
    this.lastWriteSecurity = { encrypted: store.encryptionAvailable() };
    if (!this.state.deviceIdentity?.hwid && options.deviceIdentity?.hwid) {
      this.state.deviceIdentity = options.deviceIdentity;
      this.persist();
    }
  }

  snapshot() {
    return {
      version: this.state.version,
      security: { encrypted: Boolean(this.lastWriteSecurity.encrypted || this.store.encryptionAvailable()) },
      deviceIdentity: this.state.deviceIdentity ? { ...this.state.deviceIdentity } : null,
      subscriptions: this.state.subscriptions.map(publicSubscription)
    };
  }

  persist() {
    this.lastWriteSecurity = this.store.write(this.state);
  }

  async addFromUrl({ name, url, note = '', autoUpdate = true, hwidEnabled = false }) {
    const validUrl = validateHttpUrl(url);
    if (this.state.subscriptions.some(item => item.url === validUrl)) throw new Error('Эта ссылка уже добавлена');
    const content = await fetchSubscription(validUrl, { hwidEnabled: Boolean(hwidEnabled), deviceIdentity: this.state.deviceIdentity });
    const parsed = parseSubscriptionContent(content);
    const urlObject = new URL(validUrl);
    const now = new Date().toISOString();
    const subscription = {
      id: crypto.randomUUID(),
      name: safeName(name, urlObject.hostname),
      sourceType: 'url',
      sourceHost: urlObject.hostname,
      note: safeNote(note),
      url: validUrl,
      hwidEnabled: Boolean(hwidEnabled),
      autoUpdate: Boolean(autoUpdate),
      createdAt: now,
      lastUpdated: now,
      updateError: '',
      parseWarnings: parsed.errors.length,
      servers: parsed.servers
    };
    this.state.subscriptions.push(subscription);
    this.persist();
    return { subscription: publicSubscription(subscription), snapshot: this.snapshot() };
  }

  addFromContent({ name, content, note = '', sourceType = 'text', sourceHost = '' }) {
    const text = String(content || '');
    if (Buffer.byteLength(text, 'utf8') > MAX_SUBSCRIPTION_BYTES) throw new Error('Конфигурация больше допустимых 5 МБ');
    const parsed = parseSubscriptionContent(text);
    const now = new Date().toISOString();
    const subscription = {
      id: crypto.randomUUID(),
      name: safeName(name),
      sourceType,
      sourceHost: safeName(sourceHost, ''),
      note: safeNote(note),
      url: '',
      autoUpdate: false,
      createdAt: now,
      lastUpdated: now,
      updateError: '',
      parseWarnings: parsed.errors.length,
      servers: parsed.servers
    };
    this.state.subscriptions.push(subscription);
    this.persist();
    return { subscription: publicSubscription(subscription), snapshot: this.snapshot() };
  }

  async update(id) {
    const subscription = this.state.subscriptions.find(item => item.id === id);
    if (!subscription) throw new Error('Подписка не найдена');
    if (!subscription.url) throw new Error('Локальный источник нельзя обновить по сети');
    try {
      const content = await fetchSubscription(subscription.url, { hwidEnabled: Boolean(subscription.hwidEnabled), deviceIdentity: this.state.deviceIdentity });
      const parsed = parseSubscriptionContent(content);
      subscription.servers = parsed.servers;
      subscription.lastUpdated = new Date().toISOString();
      subscription.updateError = '';
      subscription.parseWarnings = parsed.errors.length;
      this.persist();
      return { subscription: publicSubscription(subscription), snapshot: this.snapshot() };
    } catch (error) {
      subscription.updateError = error.message;
      this.persist();
      throw error;
    }
  }

  async updateAll() {
    const remote = this.state.subscriptions.filter(item => item.url);
    const results = [];
    for (const item of remote) {
      try {
        const result = await this.update(item.id);
        results.push({ id: item.id, ok: true, count: result.subscription.serverCount });
      } catch (error) {
        results.push({ id: item.id, ok: false, error: error.message });
      }
    }
    return { results, snapshot: this.snapshot() };
  }

  setHwid(id, enabled) {
    const subscription = this.state.subscriptions.find(item => item.id === id);
    if (!subscription) throw new Error('Подписка не найдена');
    if (!subscription.url) throw new Error('HWID применим только к удалённым подпискам');
    subscription.hwidEnabled = Boolean(enabled);
    this.persist();
    return { subscription: publicSubscription(subscription), snapshot: this.snapshot() };
  }

  remove(id) {
    const index = this.state.subscriptions.findIndex(item => item.id === id);
    if (index < 0) throw new Error('Подписка не найдена');
    const [removed] = this.state.subscriptions.splice(index, 1);
    this.persist();
    return { removed: { id: removed.id, name: removed.name }, snapshot: this.snapshot() };
  }

  getServerById(id) {
    for (const subscription of this.state.subscriptions) {
      const server = subscription.servers.find(item => item.id === id);
      if (server) return server;
    }
    return null;
  }

  getServersByIds(ids) {
    const wanted = new Set(ids);
    const servers = [];
    for (const subscription of this.state.subscriptions) {
      for (const server of subscription.servers) {
        if (wanted.has(server.id)) servers.push(server);
      }
    }
    return servers;
  }

  allServers() {
    return this.state.subscriptions.flatMap(subscription => subscription.servers);
  }
}

module.exports = {
  SubscriptionManager,
  fetchSubscription,
  validateHttpUrl,
  publicSubscription,
  safeNote,
  MAX_SUBSCRIPTION_BYTES
};
