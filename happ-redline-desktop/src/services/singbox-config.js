'use strict';

const { decodeBase64 } = require('./parser');

function decode(value) { try { return decodeURIComponent(value || ''); } catch (_) { return value || ''; } }
function bool(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }

function tlsOptions(params, host, explicit = {}) {
  const security = String(explicit.security || params.get('security') || '').toLowerCase();
  const enabled = ['tls', 'reality'].includes(security) || explicit.enabled;
  if (!enabled) return undefined;
  const tls = {
    enabled: true,
    server_name: explicit.sni || params.get('sni') || params.get('serverName') || host,
    insecure: explicit.insecure ?? bool(params.get('insecure') || params.get('allowInsecure')),
    utls: { enabled: true, fingerprint: explicit.fingerprint || params.get('fp') || 'chrome' }
  };
  if (security === 'reality') {
    tls.reality = {
      enabled: true,
      public_key: params.get('pbk') || params.get('publicKey') || params.get('password') || '',
      short_id: params.get('sid') || params.get('shortId') || ''
    };
    if (!tls.reality.public_key) throw new Error('В REALITY-ссылке отсутствует pbk/public key');
  }
  return tls;
}

function transportOptions(params, explicit = {}) {
  const type = String(explicit.type || params.get('type') || params.get('network') || 'tcp').toLowerCase();
  const path = decode(explicit.path || params.get('path') || '/');
  const host = explicit.host || params.get('host') || params.get('authority') || '';
  if (['tcp', 'raw'].includes(type)) return undefined;
  if (['ws', 'websocket'].includes(type)) return { type: 'ws', path, headers: host ? { Host: host } : undefined };
  if (type === 'grpc') return { type: 'grpc', service_name: decode(explicit.serviceName || params.get('serviceName') || path.replace(/^\//, '')), idle_timeout: '1m' };
  if (type === 'httpupgrade') return { type: 'httpupgrade', path, host };
  if (type === 'quic') return { type: 'quic' };
  throw new Error(`Sing-box TUN пока не поддерживает транспорт ${type}; используйте Xray Proxy`);
}

function parseUrl(raw) { try { return new URL(raw); } catch (error) { throw new Error(`Повреждена share-ссылка: ${error.message}`); } }

function vlessOutbound(raw) {
  const url = parseUrl(raw); const params = url.searchParams;
  const outbound = { type: 'vless', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, uuid: decode(url.username) };
  const flow = params.get('flow'); if (flow) outbound.flow = flow;
  const tls = tlsOptions(params, url.hostname); if (tls) outbound.tls = tls;
  const transport = transportOptions(params); if (transport) outbound.transport = transport;
  return outbound;
}

function trojanOutbound(raw) {
  const url = parseUrl(raw); const params = url.searchParams;
  const outbound = { type: 'trojan', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443, password: decode(url.username) };
  const tls = tlsOptions(params, url.hostname, { enabled: true, security: params.get('security') || 'tls' }); if (tls) outbound.tls = tls;
  const transport = transportOptions(params); if (transport) outbound.transport = transport;
  return outbound;
}

function vmessOutbound(raw) {
  let data; try { data = JSON.parse(decodeBase64(raw.slice('vmess://'.length).split('#')[0])); } catch (error) { throw new Error(`VMess JSON повреждён: ${error.message}`); }
  const params = new URLSearchParams();
  for (const key of ['sni','fp','alpn']) if (data[key]) params.set(key, data[key]);
  const outbound = { type: 'vmess', tag: 'proxy', server: data.add || data.host, server_port: Number(data.port) || 443, uuid: data.id, security: data.scy || data.security || 'auto', alter_id: Number(data.aid) || 0 };
  const tls = tlsOptions(params, outbound.server, { enabled: data.tls === 'tls', security: data.tls, sni: data.sni, fingerprint: data.fp, insecure: bool(data.allowInsecure) }); if (tls) outbound.tls = tls;
  const transport = transportOptions(params, { type: data.net || 'tcp', path: data.path, host: data.host, serviceName: data.path }); if (transport) outbound.transport = transport;
  return outbound;
}

function shadowsocksData(raw) {
  const body = raw.slice('ss://'.length).split('#')[0].split('?')[0];
  let decoded = body;
  if (!body.includes('@')) decoded = decodeBase64(body);
  const at = decoded.lastIndexOf('@');
  let userInfo = at >= 0 ? decoded.slice(0, at) : '';
  const endpoint = at >= 0 ? decoded.slice(at + 1) : decoded;
  if (body.includes('@') && !userInfo.includes(':')) userInfo = decodeBase64(userInfo);
  const split = userInfo.indexOf(':'); if (split < 1) throw new Error('Shadowsocks: отсутствует method/password');
  const colon = endpoint.lastIndexOf(':'); if (colon < 1) throw new Error('Shadowsocks: отсутствует server:port');
  return { method: userInfo.slice(0, split), password: userInfo.slice(split + 1), server: endpoint.slice(0, colon).replace(/^\[|\]$/g, ''), port: Number(endpoint.slice(colon + 1)) || 8388 };
}

function shadowsocksOutbound(raw) { const data = shadowsocksData(raw); return { type: 'shadowsocks', tag: 'proxy', server: data.server, server_port: data.port, method: data.method, password: data.password }; }

function hysteria2Outbound(raw) {
  const url = parseUrl(raw); const params = url.searchParams;
  const outbound = {
    type: 'hysteria2', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 443,
    password: decode(url.username || params.get('auth') || params.get('password') || ''),
    tls: { enabled: true, server_name: params.get('sni') || url.hostname, insecure: bool(params.get('insecure') || params.get('allowInsecure')), alpn: ['h3'] }
  };
  const ports = params.get('mport') || params.get('ports') || params.get('server_ports');
  if (ports) {
    outbound.server_ports = ports.split(',').map(item => item.trim().replace(/^(\d+)-(\d+)$/, '$1:$2')).filter(Boolean);
    outbound.hop_interval = params.get('hop-interval') || params.get('hopInterval') || '30s';
  }
  const up = Number(params.get('upmbps') || params.get('up_mbps') || params.get('up'));
  const down = Number(params.get('downmbps') || params.get('down_mbps') || params.get('down'));
  if (Number.isFinite(up) && up > 0) outbound.up_mbps = up;
  if (Number.isFinite(down) && down > 0) outbound.down_mbps = down;
  const obfs = params.get('obfs'); const password = params.get('obfs-password') || params.get('obfsPassword');
  if (obfs && password) outbound.obfs = { type: obfs, password };
  return outbound;
}

function socksOutbound(raw) {
  const url = parseUrl(raw);
  const outbound = { type: 'socks', tag: 'proxy', server: url.hostname, server_port: Number(url.port) || 1080, version: '5' };
  if (url.username) outbound.username = decode(url.username); if (url.password) outbound.password = decode(url.password);
  return outbound;
}

function outboundFromShareLink(raw) {
  const scheme = String(raw || '').split('://')[0].toLowerCase();
  if (scheme === 'vless') return vlessOutbound(raw);
  if (scheme === 'vmess') return vmessOutbound(raw);
  if (scheme === 'trojan') return trojanOutbound(raw);
  if (scheme === 'ss') return shadowsocksOutbound(raw);
  if (scheme === 'hysteria2' || scheme === 'hy2') return hysteria2Outbound(raw);
  if (scheme === 'socks' || scheme === 'socks5') return socksOutbound(raw);
  throw new Error(`Sing-box TUN не поддерживает протокол ${scheme || 'unknown'}`);
}

function buildSingBoxConfig(server, options = {}) {
  if (!server?.raw) throw new Error('У узла отсутствует исходная share-ссылка');
  const mixedPort = Number(options.mixedPort) || 10818;
  return {
    log: { level: options.logLevel || 'warn', timestamp: true },
    dns: {
      servers: [
        { type: 'local', tag: 'dns-bootstrap' },
        { type: 'https', tag: 'dns-remote', server: '1.1.1.1', server_port: 443, path: '/dns-query', tls: { enabled: true, server_name: 'cloudflare-dns.com' }, detour: 'proxy' }
      ],
      final: 'dns-remote',
      strategy: 'prefer_ipv4',
      independent_cache: true
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', interface_name: 'REDLINE-TUN', address: ['172.19.0.1/30'], mtu: Number(options.mtu) || 9000, auto_route: true, strict_route: true, stack: options.stack || 'mixed' },
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: mixedPort }
    ],
    outbounds: [outboundFromShareLink(server.raw), { type: 'direct', tag: 'direct' }],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' }
      ],
      default_domain_resolver: 'dns-bootstrap',
      final: 'proxy',
      auto_detect_interface: true
    }
  };
}

module.exports = { buildSingBoxConfig, outboundFromShareLink, tlsOptions, transportOptions, shadowsocksData };
