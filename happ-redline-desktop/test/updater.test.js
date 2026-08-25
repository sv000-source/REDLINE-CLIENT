'use strict';

// 1.9.0-beta: unit-тесты автообновления (src/services/updater.js).
// Запускаются без сети: fetch передаётся через dependency injection.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GITHUB_API_BASE,
  RELEASES_REPO,
  RELEASES_PAGE_BASE,
  PREFERRED_ASSET_NAME,
  normalizeTag,
  parseVersion,
  compareVersions,
  buildUserAgent,
  findReleaseAsset,
  extractLatestRelease,
  checkForUpdates
} = require('../src/services/updater');

function makeRelease({ version = '1.9.0-beta', publishedAt = '2026-08-25T12:00:00Z', draft = false, assets = [] } = {}) {
  return {
    tag_name: `v${version}`,
    name: `1.9.0 beta`,
    html_url: `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`,
    published_at: draft ? null : publishedAt,
    draft,
    assets
  };
}

const EXE_ASSET = {
  name: 'REDLINE.Client.exe',
  browser_download_url: 'https://github.com/sv000-source/REDLINE-CLIENT/releases/download/v1.9.1-beta/REDLINE.Client.exe',
  size: 235533824
};

test('normalizeTag: срезает v/V и пробелы, не ломает версии без префикса', () => {
  assert.equal(normalizeTag('v1.9.0-beta'), '1.9.0-beta');
  assert.equal(normalizeTag('V1.8.1'), '1.8.1');
  assert.equal(normalizeTag('  v1.2.3-beta '), '1.2.3-beta');
  assert.equal(normalizeTag('1.9.0-beta'), '1.9.0-beta');
  assert.equal(normalizeTag(''), '');
});

test('parseVersion: корректные версии', () => {
  assert.deepEqual(parseVersion('1.9.0-beta'), { major: 1, minor: 9, patch: 0, prerelease: 'beta' });
  assert.deepEqual(parseVersion('v1.8.1'), { major: 1, minor: 8, patch: 1, prerelease: '' });
  assert.deepEqual(parseVersion('0.10.2'), { major: 0, minor: 10, patch: 2, prerelease: '' });
});

test('parseVersion: мусорные значения бросают TypeError', () => {
  for (const bad of ['1.9', '1.9.0.', 'beta', '1.9.0-beta-', 'v', '', null, '1.9.0-beta 1', '1..0']) {
    assert.throws(() => parseVersion(bad), TypeError, `ожидается TypeError для ${JSON.stringify(bad)}`);
  }
});

test('compareVersions: порядок 1.x.x-beta', () => {
  assert.ok(compareVersions('1.9.0-beta', '1.8.1-beta') > 0);
  assert.ok(compareVersions('1.8.1-beta', '1.9.0-beta') < 0);
  assert.equal(compareVersions('1.9.0-beta', '1.9.0-beta'), 0);
  assert.ok(compareVersions('1.10.0-beta', '1.9.99-beta') > 0, 'minor сравнивается как число, не строка');
  assert.ok(compareVersions('2.0.0-beta', '1.99.99-beta') > 0);
  assert.ok(compareVersions('1.9.0', '1.9.0-beta') > 0, 'релиз выше своего беты');
  assert.ok(compareVersions('1.9.0-beta', '1.9.0') < 0);
  assert.ok(compareVersions('1.9.0-beta', '1.9.1') < 0);
});

test('compareVersions: нераспаковываемая версия бросает TypeError', () => {
  assert.throws(() => compareVersions('newest', '1.9.0-beta'), TypeError);
  assert.throws(() => compareVersions('1.9.0-beta', ''), TypeError);
});

test('buildUserAgent: честный User-Agent (правило 3 проекта)', () => {
  assert.equal(buildUserAgent('1.9.0-beta'), 'REDLINE-Client/1.9.0-beta');
  assert.equal(buildUserAgent('v1.9.0-beta'), 'REDLINE-Client/1.9.0-beta');
  const ua = buildUserAgent('1.9.0-beta');
  for (const impersonated of ['Miseta', 'FlClash', 'Koala', 'Prizrak', 'Mozilla', 'curl']) {
    assert.ok(!ua.includes(impersonated), `UA не должен упоминать ${impersonated}`);
  }
});

test('findReleaseAsset: предпочитает REDLINE.Client.exe, иначе первый .exe, иначе null', () => {
  const release = { assets: [
    { name: 'source.zip', browser_download_url: 'https://example.com/a.zip', size: 10 },
    { name: 'REDLINE.Client.exe', browser_download_url: 'https://example.com/exe', size: 20 },
    { name: 'REDLINE.Client-x64.exe', browser_download_url: 'https://example.com/exe2', size: 30 }
  ] };
  assert.equal(findReleaseAsset(release).name, PREFERRED_ASSET_NAME);
  assert.equal(findReleaseAsset(release).size, 20);

  const noPreferred = { assets: [{ name: 'REDLINE.Client-x64.exe', browser_download_url: 'https://example.com/exe2', size: 30 }] };
  assert.equal(findReleaseAsset(noPreferred).name, 'REDLINE.Client-x64.exe');

  const none = { assets: [{ name: 'source.zip', browser_download_url: 'https://example.com/a.zip', size: 10 }] };
  assert.equal(findReleaseAsset(none), null);
  assert.equal(findReleaseAsset({}), null);
  assert.equal(findReleaseAsset(null), null);
});

test('extractLatestRelease: берёт самый свежий, игнорирует draft и нераспознаваемое', () => {
  const releases = [
    makeRelease({ version: '1.8.1-beta', publishedAt: '2026-08-20T10:00:00Z' }),
    makeRelease({ version: '1.9.1-beta', publishedAt: '2026-08-25T10:00:00Z', assets: [EXE_ASSET] }),
    makeRelease({ version: '1.9.0-beta', publishedAt: '2026-08-24T10:00:00Z' }),
    makeRelease({ version: '2.0.0-beta', draft: true }),
    { tag_name: 'weird-tag', name: 'x', html_url: 'u', published_at: '2026-08-25T00:00:00Z', draft: false, assets: [] },
    { tag_name: 'v1.9.2-beta', name: 'x', html_url: 'u', published_at: null, draft: false, assets: [] }
  ];
  const latest = extractLatestRelease(releases);
  assert.equal(latest.version, '1.9.1-beta');
  assert.equal(latest.asset.name, 'REDLINE.Client.exe');
  assert.ok(latest.htmlUrl.startsWith('https://github.com/'));
  assert.equal(extractLatestRelease([]), null);
  assert.equal(extractLatestRelease('oops'), null);
});

function fakeFetch(releases, { status = 200, init } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => releases
    };
  };
  return { fetchFn, calls };
}

test('checkForUpdates: новая версия найдена — updateAvailable и ассет релиза', async () => {
  const { fetchFn, calls } = fakeFetch([
    makeRelease({ version: '1.8.1-beta' }),
    makeRelease({ version: '1.9.1-beta', assets: [EXE_ASSET] })
  ]);
  const result = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.checked, true);
  assert.equal(result.current, '1.9.0-beta');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latest.version, '1.9.1-beta');
  assert.equal(result.latest.asset.url, EXE_ASSET.browser_download_url);
  assert.equal(calls.length, 1, 'ровно один запрос за проверку');
  assert.ok(calls[0].url.startsWith(`${GITHUB_API_BASE}/repos/${RELEASES_REPO}/releases`));
});

test('checkForUpdates: актуальная версия — updateAvailable false', async () => {
  const { fetchFn } = fakeFetch([
    makeRelease({ version: '1.8.1-beta' }),
    makeRelease({ version: '1.9.0-beta' })
  ]);
  const result = await checkForUpdates({ currentVersion: 'v1.9.0-beta', fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latest.version, '1.9.0-beta');
});

test('checkForUpdates: только старые релизы — updateAvailable false', async () => {
  const { fetchFn } = fakeFetch([makeRelease({ version: '1.8.1-beta' })]);
  const result = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
});

test('checkForUpdates: нет опубликованных релизов — ok с пустым latest', async () => {
  const { fetchFn } = fakeFetch([]);
  const result = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.latest, null);
  assert.equal(result.updateAvailable, false);
  assert.ok(result.note.length > 0);
});

test('checkForUpdates: запрос несёт честный User-Agent и accept GitHub API', async () => {
  const { fetchFn, calls } = fakeFetch([]);
  await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn });
  const headers = calls[0].options.headers;
  assert.equal(headers['user-agent'], 'REDLINE-Client/1.9.0-beta');
  assert.equal(headers.accept, 'application/vnd.github+json');
});

test('checkForUpdates: сетевая ошибка не бросается, а возвращается в error', async () => {
  const result = await checkForUpdates({
    currentVersion: '1.9.0-beta',
    fetchFn: async () => { throw new Error('ECONNRESET'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.checked, false);
  assert.match(result.error, /ECONNRESET/);
});

test('checkForUpdates: таймаут через AbortController', async () => {
  const result = await checkForUpdates({
    currentVersion: '1.9.0-beta',
    timeoutMs: 50,
    fetchFn: (url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /таймаут/);
});

test('checkForUpdates: 404 и 403/429 — понятные сообщения', async () => {
  const notFound = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn: async () => ({ ok: false, status: 404, json: async () => null }) });
  assert.equal(notFound.ok, false);
  assert.match(notFound.error, /404/);

  const limited = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn: async () => ({ ok: false, status: 429, json: async () => null }) });
  assert.equal(limited.ok, false);
  assert.match(limited.error, /403\/429/);
});

test('checkForUpdates: не-JSON и не-массив отвечают ошибкой, а не броском', async () => {
  const badJson = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
  assert.equal(badJson.ok, false);
  assert.match(badJson.error, /ответ GitHub/);

  const notArray = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }) });
  assert.equal(notArray.ok, false);
  assert.match(notArray.error, /не список релизов/);
});

test('checkForUpdates: без доступного fetch — ok:false, без броска', async () => {
  const result = await checkForUpdates({ currentVersion: '1.9.0-beta', fetchFn: undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /Сеть недоступна/);
});

test('константы: репозиторий релизов и страница релизов совпадают', () => {
  assert.equal(RELEASES_REPO, 'sv000-source/REDLINE-CLIENT');
  assert.equal(RELEASES_PAGE_BASE, 'https://github.com/sv000-source/REDLINE-CLIENT/releases');
});
