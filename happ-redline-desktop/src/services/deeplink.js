'use strict';

const crypto = require('node:crypto');
const { parseSubscriptionContent, parseShareLink } = require('./parser');
const { validateHttpUrl } = require('./subscriptions');

const DEEP_LINK_SCHEMES = new Set(['happ:', 'redline:']);
const CRYPTO_COMMANDS = new Set(['crypt', 'crypt2', 'crypt3', 'crypt4', 'crypt5']);
const SHARE_SCHEMES = /^(vless|vmess|trojan|ss|hysteria2|hy2|socks|socks5):\/\//i;
const MAX_DEEP_LINK_LENGTH = 64 * 1024;

function decodeRepeated(value, rounds = 3) {
  let current = String(value || '').trim();
  for (let index = 0; index < rounds; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (!decoded || decoded === current) break;
      current = decoded;
    } catch (_) { break; }
  }
  return current;
}

function maybeDecodePayload(value) {
  const payload = String(value || '').trim();
  if (/^(https?:\/\/|happ:\/\/|redline:\/\/|vless:\/\/|vmess:\/\/|trojan:\/\/|ss:\/\/|hysteria2:\/\/|hy2:\/\/|socks5?:\/\/)/i.test(payload)) return payload;
  return decodeRepeated(payload);
}

function decodeBase64WrappedLink(value) {
  const input = String(value || '').trim().replace(/\s+/g, '');
  if (input.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(input)) return '';
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
    return /^(happ|redline):\/\//i.test(decoded) ? decoded : '';
  } catch (_) { return ''; }
}

function findEmbeddedAppLink(value) {
  const decoded = decodeRepeated(value);
  const match = decoded.match(/(?:happ|redline):\/\/[^\s"'<>]+/i);
  return match ? match[0] : '';
}

function extractCommandAndPayload(raw) {
  const input = String(raw || '').trim();
  if (!input || input.length > MAX_DEEP_LINK_LENGTH) throw new Error('Deep link пустой или слишком длинный');
  let url;
  try { url = new URL(input); }
  catch (_) { throw new Error('Некорректная внешняя ссылка'); }
  if (!DEEP_LINK_SCHEMES.has(url.protocol)) throw new Error('Схема внешней ссылки не поддерживается');

  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const command = url.hostname.toLowerCase();
  if (CRYPTO_COMMANDS.has(command)) throw new Error('Зашифрованные happ://crypt ссылки отключены для защиты аккаунта. Используйте открытую HTTPS-подписку.');
  if (!['add', 'import'].includes(command)) throw new Error(`Неизвестная deep-link команда: ${command || 'empty'}`);

  const queryPayload = url.searchParams.get('url') || url.searchParams.get('content') || '';
  let payload = queryPayload;
  let name = queryPayload ? (url.searchParams.get('name') || '') : '';
  if (!payload) {
    const prefix = `${scheme}://${command}/`;
    if (input.toLowerCase().startsWith(prefix)) payload = input.slice(prefix.length);
  }
  payload = maybeDecodePayload(payload);
  name = String(name).replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 100);
  if (!payload) throw new Error('Deep link не содержит подписку или конфигурацию');
  return { scheme, command, payload, name };
}

function maskedHttpDisplay(value) {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/••••••`;
}

function classifyPayload(payload, metadata) {
  if (/^https?:\/\//i.test(payload)) {
    const validUrl = validateHttpUrl(payload);
    const url = new URL(validUrl);
    if (url.protocol !== 'https:') throw new Error('Сайтовый deep link может загружать только HTTPS-подписки; HTTP можно добавить вручную');
    return {
      scheme: metadata.scheme,
      action: 'add',
      kind: 'url',
      name: metadata.name || url.hostname,
      display: maskedHttpDisplay(validUrl),
      sourceHost: url.hostname,
      payload: validUrl,
      serverCount: null,
      encrypted: Boolean(metadata.encrypted),
      cryptoMode: metadata.cryptoMode || '',
      fallbackUsed: Boolean(metadata.fallbackUsed)
    };
  }

  if (SHARE_SCHEMES.test(payload)) {
    const server = parseShareLink(payload);
    return {
      scheme: metadata.scheme,
      action: 'add',
      kind: 'content',
      name: metadata.name || server.name,
      display: `${server.protocol.toUpperCase()} · ${server.host}:${server.port}`,
      sourceHost: server.host,
      payload,
      serverCount: 1,
      encrypted: Boolean(metadata.encrypted),
      cryptoMode: metadata.cryptoMode || '',
      fallbackUsed: Boolean(metadata.fallbackUsed)
    };
  }

  const parsed = parseSubscriptionContent(payload);
  return {
    scheme: metadata.scheme,
    action: 'add',
    kind: 'content',
    name: metadata.name || 'Внешняя подписка',
    display: `Встроенная подписка · ${parsed.servers.length} узлов`,
    sourceHost: '',
    payload,
    serverCount: parsed.servers.length,
    encrypted: Boolean(metadata.encrypted),
    cryptoMode: metadata.cryptoMode || '',
    fallbackUsed: Boolean(metadata.fallbackUsed)
  };
}

async function parseDeepLink(raw, depth = 0) {
  if (depth > 5) throw new Error('Слишком много вложенных deep-link оболочек');
  const extracted = extractCommandAndPayload(raw);
  const payload = decodeRepeated(extracted.payload);
  if (/^(happ|redline):\/\//i.test(payload)) return parseDeepLink(payload, depth + 1);
  const base64Wrapped = decodeBase64WrappedLink(payload);
  if (base64Wrapped) return parseDeepLink(base64Wrapped, depth + 1);
  const embedded = findEmbeddedAppLink(payload);
  if (embedded) return parseDeepLink(embedded, depth + 1);
  return classifyPayload(payload, { scheme: extracted.scheme, name: extracted.name, encrypted: false, cryptoMode: '' });
}

class PendingDeepLinks {
  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  create(parsed) {
    this.prune();
    const token = crypto.randomUUID();
    const createdAt = Date.now();
    this.items.set(token, { ...parsed, token, createdAt, expiresAt: createdAt + this.ttlMs });
    return this.publicItem(this.items.get(token));
  }

  publicItem(item) {
    return {
      token: item.token,
      scheme: item.scheme,
      action: item.action,
      kind: item.kind,
      name: item.name,
      display: item.display,
      sourceHost: item.sourceHost,
      serverCount: item.serverCount,
      encrypted: Boolean(item.encrypted),
      cryptoMode: item.cryptoMode || '',
      fallbackUsed: Boolean(item.fallbackUsed),
      expiresAt: new Date(item.expiresAt).toISOString()
    };
  }

  take(token) {
    this.prune();
    const item = this.items.get(token);
    if (!item) throw new Error('Запрос импорта устарел или уже обработан');
    this.items.delete(token);
    return item;
  }

  reject(token) { return this.items.delete(token); }

  prune() {
    const now = Date.now();
    for (const [token, item] of this.items) if (item.expiresAt <= now) this.items.delete(token);
  }
}

function findDeepLinks(argv) {
  return (Array.isArray(argv) ? argv : []).filter(value => /^(happ|redline):\/\//i.test(String(value || '').trim()));
}

module.exports = { parseDeepLink, extractCommandAndPayload, PendingDeepLinks, findDeepLinks, MAX_DEEP_LINK_LENGTH };
