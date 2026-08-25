'use strict';

const { decodeBase64 } = require('./parser');

function boolParam(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberParam(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decode(value) {
  try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; }
}

function transportMethod(value) {
  const type = String(value || 'tcp').toLowerCase();
  return ({ tcp: 'raw', raw: 'raw', ws: 'websocket', websocket: 'websocket', grpc: 'grpc', xhttp: 'xhttp', splithttp: 'xhttp', httpupgrade: 'httpupgrade', kcp: 'kcp', mkcp: 'kcp', quic: 'quic' })[type] || type;
}

function buildSecurity(params, host, explicitSecurity = '') {
  const security = String(explicitSecurity || params.get('security') || 'none').toLowerCase();
  const serverName = params.get('sni') || params.get('serverName') || host;
  const fingerprint = params.get('fp') || params.get('fingerprint') || 'chrome';
  if (security === 'reality') {
    const password = params.get('pbk') || params.get('password') || params.get('publicKey') || '';
    if (!password) throw new Error('В REALITY-конфигурации отсутствует public key (pbk)');
    return {
      security: 'reality',
      realitySettings: {
        serverName,
        fingerprint,
        password,
        shortId: params.get('sid') || params.get('shortId') || '',
        spiderX: decode(params.get('spx') || params.get('spiderX') || '')
      }
    };
  }
  if (security === 'tls') {
    const alpn = (params.get('alpn') || '').split(',').map(item => item.trim()).filter(Boolean);
    const tlsSettings = {
      serverName,
      allowInsecure: boolParam(params.get('allowInsecure') || params.get('insecure')),
      fingerprint
    };
    if (alpn.length) tlsSettings.alpn = alpn;
    return { security: 'tls', tlsSettings };
  }
  return { security: 'none' };
}

function buildTransport(params, host, explicitType = '', explicit = {}) {
  const method = transportMethod(explicitType || params.get('type') || params.get('network') || 'tcp');
  const stream = { method };
  const path = decode(explicit.path || params.get('path') || '/');
  const requestHost = explicit.host || params.get('host') || params.get('authority') || '';

  if (method === 'raw') {
    stream.rawSettings = { header: { type: params.get('headerType') || explicit.headerType || 'none' } };
  } else if (method === 'websocket') {
    stream.wsSettings = { path, host: requestHost };
  } else if (method === 'grpc') {
    stream.grpcSettings = {
      serviceName: decode(explicit.serviceName || params.get('serviceName') || path.replace(/^\//, '')),
      authority: requestHost,
      multiMode: (explicit.mode || params.get('mode')) === 'multi'
    };
  } else if (method === 'httpupgrade') {
    stream.httpupgradeSettings = { path, host: requestHost };
  } else if (method === 'xhttp') {
    stream.xhttpSettings = { path, host: requestHost, mode: explicit.mode || params.get('mode') || 'auto' };
  } else if (method === 'kcp') {
    stream.kcpSettings = {
      mtu: numberParam(params.get('mtu'), 1350),
      tti: numberParam(params.get('tti'), 20),
      uplinkCapacity: numberParam(params.get('uplinkCapacity'), 5),
      downlinkCapacity: numberParam(params.get('downlinkCapacity'), 20),
      congestion: boolParam(params.get('congestion')),
      readBufferSize: numberParam(params.get('readBufferSize'), 2),
      writeBufferSize: numberParam(params.get('writeBufferSize'), 2),
      header: { type: params.get('headerType') || 'none' },
      seed: params.get('seed') || ''
    };
  } else if (method === 'quic') {
    stream.quicSettings = {
      security: params.get('quicSecurity') || 'none',
      key: params.get('key') || '',
      header: { type: params.get('headerType') || 'none' }
    };
  }

  Object.assign(stream, buildSecurity(params, host, explicit.security));
  return stream;
}

function parseUrl(raw) {
  try { return new URL(raw); }
  catch (error) { throw new Error(`Ссылка узла повреждена: ${error.message}`); }
}

function vlessOutbound(raw) {
  const url = parseUrl(raw);
  const id = decode(url.username);
  if (!id) throw new Error('В VLESS-конфигурации отсутствует ID');
  return {
    tag: 'proxy', protocol: 'vless',
    settings: {
      address: url.hostname,
      port: Number(url.port) || 443,
      id,
      encryption: url.searchParams.get('encryption') || 'none',
      flow: url.searchParams.get('flow') || '',
      level: 0
    },
    streamSettings: buildTransport(url.searchParams, url.hostname)
  };
}

function trojanOutbound(raw) {
  const url = parseUrl(raw);
  const password = decode(url.username);
  if (!password) throw new Error('В Trojan-конфигурации отсутствует пароль');
  const security = url.searchParams.get('security') || 'tls';
  return {
    tag: 'proxy', protocol: 'trojan',
    settings: { address: url.hostname, port: Number(url.port) || 443, password, level: 0 },
    streamSettings: buildTransport(url.searchParams, url.hostname, '', { security })
  };
}

function vmessOutbound(raw) {
  let data;
  try { data = JSON.parse(decodeBase64(raw.slice('vmess://'.length).split('#')[0])); }
  catch (error) { throw new Error(`VMess JSON повреждён: ${error.message}`); }
  const params = new URLSearchParams();
  if (data.sni) params.set('sni', data.sni);
  if (data.fp) params.set('fp', data.fp);
  if (data.alpn) params.set('alpn', data.alpn);
  if (data.allowInsecure) params.set('allowInsecure', data.allowInsecure);
  return {
    tag: 'proxy', protocol: 'vmess',
    settings: {
      address: data.add || data.host,
      port: Number(data.port) || 443,
      id: data.id,
      security: data.scy || data.security || 'auto',
      level: 0
    },
    streamSettings: buildTransport(params, data.add || data.host, data.net || data.type || 'tcp', {
      security: data.tls || 'none', path: data.path || '/', host: data.host || '', serviceName: data.path || '', headerType: data.type || '', mode: data.mode || ''
    })
  };
}

function shadowsocksCredentials(raw) {
  const withoutScheme = raw.slice('ss://'.length);
  const body = withoutScheme.split('#')[0].split('?')[0];
  let endpoint = body;
  let userInfo;
  let hostPort;
  if (body.includes('@')) {
    const at = body.lastIndexOf('@');
    userInfo = body.slice(0, at);
    hostPort = body.slice(at + 1);
    if (!userInfo.includes(':')) userInfo = decodeBase64(userInfo);
  } else {
    endpoint = decodeBase64(body);
    const at = endpoint.lastIndexOf('@');
    if (at < 0) throw new Error('Shadowsocks-конфигурация не содержит адрес');
    userInfo = endpoint.slice(0, at);
    hostPort = endpoint.slice(at + 1);
  }
  const split = userInfo.indexOf(':');
  if (split < 1) throw new Error('Shadowsocks-конфигурация не содержит метод и пароль');
  const method = userInfo.slice(0, split);
  const password = userInfo.slice(split + 1);
  let host;
  let port;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']'); host = hostPort.slice(1, end); port = Number(hostPort.slice(end + 2));
  } else {
    const colon = hostPort.lastIndexOf(':'); host = hostPort.slice(0, colon); port = Number(hostPort.slice(colon + 1));
  }
  return { method, password, host, port: port || 8388 };
}

function shadowsocksOutbound(raw) {
  const data = shadowsocksCredentials(raw);
  return { tag: 'proxy', protocol: 'shadowsocks', settings: { address: data.host, port: data.port, method: data.method, password: data.password, level: 0 } };
}

function socksOutbound(raw) {
  const url = parseUrl(raw);
  const settings = { address: url.hostname, port: Number(url.port) || 1080, level: 0 };
  if (url.username) settings.user = decode(url.username);
  if (url.password) settings.pass = decode(url.password);
  return { tag: 'proxy', protocol: 'socks', settings };
}

function hysteriaOutbound(raw) {
  const url = parseUrl(raw);
  const params = url.searchParams;
  const password = decode(url.username || params.get('auth') || params.get('password') || '');
  if (!password) throw new Error('В Hysteria2-конфигурации отсутствует пароль');
  const streamSettings = {
    method: 'hysteria',
    security: 'tls',
    hysteriaSettings: { version: 2, auth: password, udpIdleTimeout: numberParam(params.get('udpIdleTimeout'), 60) },
    tlsSettings: {
      serverName: params.get('sni') || url.hostname,
      allowInsecure: boolParam(params.get('insecure')),
      fingerprint: params.get('fp') || 'chrome'
    }
  };
  const obfs = params.get('obfs');
  const obfsPassword = params.get('obfs-password') || params.get('obfsPassword');
  if (obfs === 'salamander' && obfsPassword) {
    streamSettings.finalmask = { udp: [{ type: 'salamander', settings: { password: obfsPassword } }] };
  }
  return {
    tag: 'proxy', protocol: 'hysteria',
    settings: { version: 2, address: url.hostname, port: Number(url.port) || 443 },
    streamSettings
  };
}

function outboundFromShareLink(raw) {
  const scheme = String(raw || '').split('://')[0].toLowerCase();
  if (scheme === 'vless') return vlessOutbound(raw);
  if (scheme === 'vmess') return vmessOutbound(raw);
  if (scheme === 'trojan') return trojanOutbound(raw);
  if (scheme === 'ss') return shadowsocksOutbound(raw);
  if (scheme === 'socks' || scheme === 'socks5') return socksOutbound(raw);
  if (scheme === 'hysteria2' || scheme === 'hy2') return hysteriaOutbound(raw);
  throw new Error(`Xray-подключение для протокола ${scheme || 'unknown'} не поддерживается`);
}

function buildXrayConfig(server, ports, options = {}) {
  if (!server?.raw) throw new Error('У выбранного узла отсутствует исходная конфигурация');
  const socksPort = Number(ports.socks);
  const httpPort = Number(ports.http);
  if (!Number.isInteger(socksPort) || !Number.isInteger(httpPort)) throw new Error('Не заданы локальные порты Xray');
  const outbound = outboundFromShareLink(server.raw);
  return {
    log: { loglevel: options.loglevel || 'warning' },
    inbounds: [
      {
        tag: 'socks-in', listen: '127.0.0.1', port: socksPort, protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      },
      {
        tag: 'http-in', listen: '127.0.0.1', port: httpPort, protocol: 'http',
        settings: {},
        sniffing: { enabled: true, destOverride: ['http', 'tls'], routeOnly: false }
      }
    ],
    outbounds: [
      outbound,
      { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } }
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: options.bypassPrivate === false ? [] : [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }
      ]
    }
  };
}

module.exports = {
  buildXrayConfig,
  outboundFromShareLink,
  buildTransport,
  shadowsocksCredentials
};
