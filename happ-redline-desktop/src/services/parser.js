'use strict';

const crypto = require('node:crypto');

const SUPPORTED_SCHEMES = new Set([
  'vless:', 'vmess:', 'trojan:', 'ss:', 'hysteria2:', 'hy2:', 'socks:', 'socks5:'
]);

function decodeBase64(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  if (!normalized) return '';
  const padding = normalized.length % 4;
  const padded = padding ? normalized + '='.repeat(4 - padding) : normalized;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function looksLikeShareList(value) {
  return /(^|\n)\s*(vless|vmess|trojan|ss|hysteria2|hy2|socks5?):\/\//im.test(value);
}

function decodeSubscriptionEnvelope(content) {
  const input = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!input) return '';
  if (looksLikeShareList(input) || input.startsWith('{') || input.startsWith('[')) return input;
  try {
    const decoded = decodeBase64(input);
    if (looksLikeShareList(decoded) || decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) {
      return decoded.trim();
    }
  } catch (_) {
    // The input is not a base64 subscription envelope.
  }
  return input;
}

function safeDecode(value, fallback = '') {
  try { return decodeURIComponent(value || fallback); } catch (_) { return value || fallback; }
}

function stableId(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

function normalizePort(value, fallback) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function baseServer(raw, protocol, name, host, port, details = {}) {
  const cleanedHost = String(host || '').replace(/^\[|\]$/g, '').trim();
  if (!cleanedHost) throw new Error('В конфигурации отсутствует адрес сервера');
  return {
    id: stableId(raw),
    name: String(name || `${protocol.toUpperCase()} · ${cleanedHost}`).slice(0, 160),
    protocol,
    host: cleanedHost,
    port: normalizePort(port, protocol === 'socks' ? 1080 : 443),
    transport: details.transport || '',
    security: details.security || '',
    sni: details.sni || '',
    raw
  };
}

function parseUrlBased(raw, protocol) {
  const url = new URL(raw);
  const name = safeDecode(url.hash.slice(1), '');
  return baseServer(raw, protocol, name, url.hostname, url.port, {
    transport: url.searchParams.get('type') || url.searchParams.get('network') || '',
    security: url.searchParams.get('security') || (protocol === 'trojan' ? 'tls' : ''),
    sni: url.searchParams.get('sni') || url.searchParams.get('peer') || ''
  });
}

function parseVmess(raw) {
  const payload = raw.slice('vmess://'.length).split('#')[0];
  const json = JSON.parse(decodeBase64(payload));
  return baseServer(raw, 'vmess', json.ps || '', json.add || json.host, json.port, {
    transport: json.net || json.type || '',
    security: json.tls || '',
    sni: json.sni || json.host || ''
  });
}

function parseShadowsocks(raw) {
  const withoutScheme = raw.slice('ss://'.length);
  const [bodyWithQuery, fragment = ''] = withoutScheme.split('#', 2);
  const body = bodyWithQuery.split('?')[0];
  let endpoint = body;

  // SIP002 can encode only userinfo or the entire userinfo@host:port value.
  if (!body.includes('@')) endpoint = decodeBase64(body);
  const at = endpoint.lastIndexOf('@');
  const hostPort = at >= 0 ? endpoint.slice(at + 1) : endpoint;

  let host = '';
  let port = 8388;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    host = hostPort.slice(1, end);
    port = normalizePort(hostPort.slice(end + 2), 8388);
  } else {
    const colon = hostPort.lastIndexOf(':');
    host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    port = normalizePort(colon >= 0 ? hostPort.slice(colon + 1) : '', 8388);
  }

  return baseServer(raw, 'shadowsocks', safeDecode(fragment, ''), host, port, {
    transport: 'tcp/udp',
    security: 'shadowsocks'
  });
}

function parseShareLink(raw) {
  const trimmed = String(raw || '').trim();
  const schemeMatch = trimmed.match(/^([a-z0-9+.-]+):\/\//i);
  if (!schemeMatch) throw new Error('Неизвестный формат конфигурации');
  const scheme = `${schemeMatch[1].toLowerCase()}:`;
  if (!SUPPORTED_SCHEMES.has(scheme)) throw new Error(`Протокол ${schemeMatch[1]} пока не поддерживается`);

  if (scheme === 'vmess:') return parseVmess(trimmed);
  if (scheme === 'ss:') return parseShadowsocks(trimmed);
  if (scheme === 'hy2:' || scheme === 'hysteria2:') return parseUrlBased(trimmed, 'hysteria2');
  if (scheme === 'socks:' || scheme === 'socks5:') return parseUrlBased(trimmed, 'socks');
  return parseUrlBased(trimmed, scheme.slice(0, -1));
}

function parseJsonSubscription(text) {
  const value = JSON.parse(text);
  const links = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') links.push(item);
      else if (item && typeof item.url === 'string') links.push(item.url);
    }
    return links;
  }

  if (Array.isArray(value.servers)) {
    for (const item of value.servers) {
      if (typeof item === 'string') links.push(item);
      else if (item && typeof item.url === 'string') links.push(item.url);
    }
  }
  if (Array.isArray(value.links)) links.push(...value.links.filter(item => typeof item === 'string'));
  if (typeof value.subscription === 'string') links.push(value.subscription);
  return links;
}

function parseSubscriptionContent(content) {
  const decoded = decodeSubscriptionEnvelope(content);
  let lines = [];

  if (decoded.startsWith('{') || decoded.startsWith('[')) {
    try { lines = parseJsonSubscription(decoded); }
    catch (error) { throw new Error(`JSON подписки не распознан: ${error.message}`); }
  } else {
    lines = decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }

  const servers = [];
  const errors = [];
  const seen = new Set();
  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith('//')) continue;
    try {
      const server = parseShareLink(line);
      if (!seen.has(server.id)) {
        seen.add(server.id);
        servers.push(server);
      }
    } catch (error) {
      errors.push({ line: line.slice(0, 80), message: error.message });
    }
  }

  if (!servers.length) {
    const detail = errors[0]?.message || 'В ответе нет поддерживаемых ссылок';
    throw new Error(`Не удалось найти серверы: ${detail}`);
  }

  return { servers, errors, totalLines: lines.length };
}

module.exports = {
  SUPPORTED_SCHEMES,
  decodeBase64,
  decodeSubscriptionEnvelope,
  parseShareLink,
  parseSubscriptionContent
};
