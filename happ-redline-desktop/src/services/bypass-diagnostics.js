'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const { performance } = require('node:perf_hooks');

const DEFAULT_TARGETS = Object.freeze([
  { id: 'youtube', name: 'YOUTUBE', host: 'www.youtube.com', url: 'https://www.youtube.com/generate_204', expected: [200, 204] },
  { id: 'discord', name: 'DISCORD GATEWAY', host: 'discord.com', url: 'https://discord.com/api/v10/gateway', expected: [200] }
]);

function httpsProbe(target, timeout = 10_000) {
  const started = performance.now();
  return new Promise(resolve => {
    const request = https.request(target.url, {
      method: 'GET',
      headers: { 'user-agent': 'REDLINE-DPI-Diagnostics/1.2', 'accept': '*/*' },
      timeout,
      rejectUnauthorized: true
    }, response => {
      let received = 0;
      response.on('data', chunk => {
        received += chunk.length;
        if (received > 64 * 1024) request.destroy();
      });
      response.on('end', () => {
        const latency = Math.max(1, Math.round(performance.now() - started));
        const reachable = response.statusCode > 0 && response.statusCode < 500;
        const expected = target.expected?.includes(response.statusCode);
        resolve({ ok: reachable, expected, status: response.statusCode, latency, error: reachable ? '' : `HTTP ${response.statusCode}` });
      });
    });
    request.once('timeout', () => request.destroy(new Error('HTTPS timeout')));
    request.once('error', error => resolve({ ok: false, expected: false, status: null, latency: null, error: error.message }));
    request.end();
  });
}

async function testTarget(target, options = {}) {
  const resolver = options.resolver || (host => dns.lookup(host, { all: true }));
  const requester = options.requester || httpsProbe;
  const started = new Date().toISOString();
  let addresses;
  try {
    addresses = await resolver(target.host);
    if (!Array.isArray(addresses) || !addresses.length) throw new Error('DNS returned no addresses');
  } catch (error) {
    return { id: target.id, name: target.name, ok: false, stage: 'dns', addresses: [], error: error.message, checkedAt: started };
  }
  const web = await requester(target, options.timeout || 10_000);
  return { id: target.id, name: target.name, ...web, stage: web.ok ? 'https' : 'https', addresses: addresses.map(item => item.address || String(item)).slice(0, 4), checkedAt: started };
}

async function runBypassDiagnostics(options = {}) {
  const targets = options.targets || DEFAULT_TARGETS;
  const results = [];
  for (const target of targets) {
    options.onEvent?.({ type: 'test', level: 'info', message: `DNS/TLS probe: ${target.name}`, target: target.id });
    const result = await testTarget(target, options);
    results.push(result);
    options.onEvent?.({
      type: 'test', level: result.ok ? 'info' : 'error', target: target.id,
      message: result.ok ? `${target.name}: ONLINE · HTTP ${result.status} · ${result.latency} ms` : `${target.name}: FAILED · ${result.error}`,
      result
    });
  }
  const passed = results.filter(item => item.ok).length;
  return { ok: passed === results.length, passed, total: results.length, results, checkedAt: new Date().toISOString() };
}

module.exports = { DEFAULT_TARGETS, httpsProbe, testTarget, runBypassDiagnostics };
