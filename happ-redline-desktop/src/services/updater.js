'use strict';

// REDLINE Client 1.9.0-beta — автообновление через GitHub Releases.
//
// Проверяет последние опубликованные релизы sv000-source/REDLINE-CLIENT
// по api.github.com (обычный HTTPS, без CDN) и сообщает, появилась ли
// новая версия. Установка — ручная: релиз выкладывает сам пользователь,
// файл REDLINE.Client.exe заменяется на новый, SHA-256 сверяется по
// описанию релиза.
//
// Правила проекта:
// - п.3 — честный User-Agent REDLINE-Client/<version>; ни под кого
//   чужого не маскируемся;
// - п.2 — никаких встроенных серверов: только публичный API GitHub;
// - без телеметрии: за проверку — один GET-запрос, ничего не отправляется,
//   кроме User-Agent.
//
// Чистые функции экспортируются для unit-тестов (test/updater.test.js),
// сеть получает через dependency injection (fetchFn), поэтому тесты
// не ходят в интернет.

const GITHUB_API_BASE = 'https://api.github.com';
const RELEASES_REPO = 'sv000-source/REDLINE-CLIENT';
const RELEASES_PAGE_BASE = `https://github.com/${RELEASES_REPO}/releases`;
const PREFERRED_ASSET_NAME = 'REDLINE.Client.exe';
const DEFAULT_TIMEOUT_MS = 15000;

// Срезаем ведущий "v" с тега: "v1.9.0-beta" -> "1.9.0-beta".
function normalizeTag(tag) {
  const value = String(tag == null ? '' : tag).trim();
  return /^[vV]/.test(value) ? value.slice(1) : value;
}

// Разбирает "1.9.0-beta" / "v1.8.1" и т.п.
// Бросает TypeError на нераспаковываемых значениях.
function parseVersion(input) {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z](?:[0-9A-Za-z.]*[0-9A-Za-z])?))?$/.exec(normalizeTag(input));
  if (!match) throw new TypeError(`Не удалось разобрать версию: ${JSON.stringify(String(input))}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  };
}

// Принимает строку ("1.9.0-beta") или уже разобранный объект
// { major, minor, patch, prerelease }.
function toComparable(value) {
  if (typeof value === 'string') return parseVersion(value);
  if (value && Number.isInteger(value.major) && Number.isInteger(value.minor) && Number.isInteger(value.patch)) return value;
  throw new TypeError(`Не удалось разобрать версию: ${JSON.stringify(String(value))}`);
}

// -1, если a < b; 0 — равны; 1, если a > b.
// Пререлиз ниже релиза с теми же номерами (1.9.0-beta < 1.9.0);
// у двух пререлизов префикс сравнивается лексикографически
// (в проекте всегда "beta"). Нераспаковываемые значения -> TypeError.
function compareVersions(a, b) {
  const left = toComparable(a);
  const right = toComparable(b);
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : left.prerelease > right.prerelease ? 1 : 0;
}

// Честный User-Agent (правило 3): только наше имя и версия.
function buildUserAgent(version) {
  return `REDLINE-Client/${normalizeTag(version)}`;
}

// Из ассетов релиза выбирает файл установки: в первую очередь точное
// совпадение REDLINE.Client.exe, иначе первый .exe, иначе null.
function findReleaseAsset(release, preferredName = PREFERRED_ASSET_NAME) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const preferred = assets.find(asset => asset?.name === preferredName);
  const candidate = preferred || assets.find(asset => String(asset?.name || '').toLowerCase().endsWith('.exe'));
  if (!candidate) return null;
  return {
    name: candidate.name,
    url: candidate.browser_download_url || candidate.url || '',
    size: Number(candidate.size) || 0
  };
}

// Из списка релизов (ответ /repos/{repo}/releases) — самый свежий
// опубликованный с распаковываемой версией.
// /releases/latest намеренно НЕ используется: он игнорирует
// pre-release-теги, а наши версии — всегда "-beta".
function extractLatestRelease(releases) {
  let latest = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || !release.published_at) continue;
    let version;
    try { version = parseVersion(release.tag_name); } catch (_) { continue; }
    if (!latest || compareVersions(version, latest.version) > 0) {
      latest = {
        version: normalizeTag(release.tag_name),
        name: release.name || release.tag_name || '',
        htmlUrl: release.html_url || '',
        publishedAt: release.published_at || '',
        asset: findReleaseAsset(release)
      };
    }
  }
  return latest;
}

// Проверка обновлений. Возвращает объект, никогда не бросает:
//   { ok: true,  checked: true,  current, latest: {...}|null, updateAvailable: bool, note?: string }
//   { ok: false, checked: false, current, error: string }
async function checkForUpdates(options = {}) {
  const currentVersion = normalizeTag(options.currentVersion || '0.0.0');
  // Если вызывающий явно передал fetchFn (включая undefined) — глобальный
  // fetch не подменяем: тесты не должны ходить в сеть.
  const hasExplicitFetch = Object.prototype.hasOwnProperty.call(options, 'fetchFn');
  const fetchFn = hasExplicitFetch ? options.fetchFn : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    return { ok: false, checked: false, current: currentVersion, error: 'Сеть недоступна в этой среде' };
  }
  const apiBase = String(options.apiBase || GITHUB_API_BASE).replace(/\/+$/, '');
  const repo = String(options.repo || RELEASES_REPO);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(`${apiBase}/repos/${repo}/releases?per_page=30`, {
      method: 'GET',
      headers: { accept: 'application/vnd.github+json', 'user-agent': buildUserAgent(currentVersion) },
      signal: controller.signal,
      redirect: 'follow'
    });
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'таймаут' : (error?.message || 'сетевая ошибка');
    return { ok: false, checked: false, current: currentVersion, error: `Не удалось запросить GitHub: ${reason}` };
  } finally {
    clearTimeout(timer);
  }

  let releases;
  try {
    if (!response.ok) {
      if (response.status === 404) return { ok: false, checked: false, current: currentVersion, error: 'Репозиторий релизов не найден (404)' };
      if (response.status === 403 || response.status === 429) return { ok: false, checked: false, current: currentVersion, error: 'Лимит запросов GitHub (403/429) — повторите позже' };
      return { ok: false, checked: false, current: currentVersion, error: `GitHub API вернул HTTP ${response.status}` };
    }
    releases = await response.json();
  } catch (error) {
    return { ok: false, checked: false, current: currentVersion, error: `Не удалось прочитать ответ GitHub: ${error?.message || 'некорректный JSON'}` };
  }

  if (!Array.isArray(releases)) {
    return { ok: false, checked: false, current: currentVersion, error: 'Неожиданный ответ GitHub: не список релизов' };
  }

  const latest = extractLatestRelease(releases);
  const updateAvailable = Boolean(latest) && compareVersions(latest.version, currentVersion) > 0;
  return {
    ok: true,
    checked: true,
    current: currentVersion,
    latest,
    updateAvailable,
    note: latest ? '' : 'Опубликованных релизов с распознанной версией не найдено'
  };
}

module.exports = {
  GITHUB_API_BASE,
  RELEASES_REPO,
  RELEASES_PAGE_BASE,
  PREFERRED_ASSET_NAME,
  DEFAULT_TIMEOUT_MS,
  normalizeTag,
  parseVersion,
  compareVersions,
  buildUserAgent,
  findReleaseAsset,
  extractLatestRelease,
  checkForUpdates
};
