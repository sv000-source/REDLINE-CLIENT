'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

function validateTarget(host, port) {
  const value = String(host || '').trim();
  const numericPort = Number(port);
  if (!value || value.length > 253 || /[\s/\\"'`;|&$<>]/.test(value)) throw new Error('Недопустимый адрес узла');
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error('Недопустимый порт узла');
  return { host: value, port: numericPort };
}

async function tcpPing(host, port, timeout = 3500) {
  const target = validateTarget(host, port);
  await dns.lookup(target.host);
  const started = performance.now();

  return new Promise(resolve => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish({ ok: true, latency: Math.max(1, Math.round(performance.now() - started)), method: 'TCP' }));
    socket.once('timeout', () => finish({ ok: false, latency: null, method: 'TCP', error: 'Тайм-аут TCP' }));
    socket.once('error', error => finish({ ok: false, latency: null, method: 'TCP', error: error.code || error.message }));
  });
}

function icmpPing(host, timeout = 3500) {
  const target = validateTarget(host, 1);
  const isWindows = process.platform === 'win32';
  const args = isWindows
    ? ['-n', '1', '-w', String(timeout), target.host]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeout / 1000))), target.host];
  const started = performance.now();

  return new Promise(resolve => {
    execFile('ping', args, { timeout: timeout + 1200, windowsHide: true, encoding: 'utf8' }, (error, stdout = '') => {
      if (error) {
        resolve({ ok: false, latency: null, method: 'ICMP', error: error.killed ? 'Тайм-аут ICMP' : (error.code || 'ICMP недоступен') });
        return;
      }
      const match = stdout.match(/(?:time|время|temps|zeit)[=<]\s*(\d+(?:[.,]\d+)?)\s*(?:ms|мс)/i);
      const measured = match ? Math.max(1, Math.round(Number(match[1].replace(',', '.')))) : Math.max(1, Math.round(performance.now() - started));
      resolve({ ok: true, latency: measured, method: 'ICMP' });
    });
  });
}

async function pingServer(server, timeout = 3500) {
  const startedAt = new Date().toISOString();
  let result;
  if (server.protocol === 'hysteria2') {
    result = await icmpPing(server.host, timeout);
  } else {
    result = await tcpPing(server.host, server.port, timeout);
    // A closed TCP port can still belong to a reachable endpoint. ICMP is a useful fallback,
    // but the method is clearly reported so it is not confused with a proxy handshake.
    if (!result.ok) {
      const fallback = await icmpPing(server.host, Math.min(timeout, 2500));
      if (fallback.ok) result = fallback;
    }
  }
  return { ...result, serverId: server.id, checkedAt: startedAt };
}

async function pingMany(servers, options = {}) {
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 6, 12));
  const timeout = Math.max(500, Math.min(Number(options.timeout) || 3500, 10000));
  const queue = [...servers];
  const results = [];

  async function worker() {
    while (queue.length) {
      const server = queue.shift();
      try { results.push(await pingServer(server, timeout)); }
      catch (error) { results.push({ ok: false, latency: null, method: 'ERROR', error: error.message, serverId: server.id, checkedAt: new Date().toISOString() }); }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

module.exports = { tcpPing, icmpPing, pingServer, pingMany };
