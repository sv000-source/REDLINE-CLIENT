#!/usr/bin/env bash
# ============================================================================
# Сборка REDLINE.Client.exe (portable, Windows x64) + публикация релиза.
#
# Выполняется на раннере GitHub Actions (windows-latest). Песочница агента
# не имеет доступа к CDN GitHub (objects.githubusercontent.com — SSL reset),
# поэтому Electron и официальные движки скачиваются только с раннера —
# тот же транспорт, что использовался для разбора релизного EXE 1.8.1-beta.
#
# Что делает:
#   1. npm ci (package-lock.json из ветки)
#   2. npm run prepare:engines — официальные Xray v26.7.28 / Sing-box 1.13.19 /
#      Flowseal Zapret 1.10.1 с проверкой SHA-256
#   3. npm test
#   4. npx electron-builder --win portable --x64 -> release/REDLINE.Client.exe
#   5. Публикует GitHub-релиз $RELEASE_TAG с ассетом и SHA-256 в описании
#      (создаёт, если релиза нет; обновляет ассет и описание, если есть).
#
# Требуется: переменная окружения RELEASE_TAG (по умолчанию v1.9.0-beta) и
# токен GitHub с правом contents:write (в Actions — GITHUB_TOKEN).
# ============================================================================

set -euo pipefail

TAG="${RELEASE_TAG:-v1.9.0-beta}"
VERSION="${TAG#v}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/happ-redline-desktop"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
COMMIT="$(git -C "$ROOT" rev-parse HEAD)"

echo "==> Сборка $TAG из ветки $BRANCH @ $COMMIT"

cd "$APP"

echo "==> npm ci"
npm ci --no-audit --no-fund

echo "==> Официальные движки с проверкой SHA-256"
npm run prepare:engines

echo "==> Тесты"
npm test

echo "==> electron-builder: portable win x64"
npx electron-builder --win portable --x64

EXE="$APP/release/REDLINE.Client.exe"
if [ ! -f "$EXE" ]; then
  echo "ОШИБКА: артефакт не найден: $EXE" >&2
  ls -la "$APP/release" >&2 || true
  exit 1
fi

echo "==> Артефакт"
ls -la "$EXE"
SHA256="$(sha256sum "$EXE" | awk '{print $1}')"
SIZE="$(stat -c %s "$EXE")"
ASAR_SHA="$(sha256sum "$ROOT/resources/app.asar" | awk '{print $1}')"

PKG_VERSION="$(node -p "require('./package.json').version")"
if [ "$PKG_VERSION" != "$VERSION" ]; then
  echo "ПРЕДУПРЕЖДЕНИЕ: package.json версия ($PKG_VERSION) != версия тега ($VERSION)" >&2
fi

BODY="$(cat <<EOF
**REDLINE Client $VERSION (Windows x64, portable)**

Что нового в $VERSION:

- **Автообновление через GitHub Releases** — \`src/services/updater.js\`:
  проверка свежих опубликованных релизов по \`api.github.com\`
  (один GET-запрос, честный User-Agent \`REDLINE-Client/$VERSION\`,
  без телеметрии). При запуске — тихо, статус в трей-иконке и в настройках;
  вручную — кнопка «Проверить» в настройках или пункт меню трея.
  Установка ручная: замените этот файл на новый, SHA-256 сверяется
  по описанию релиза.
- **Трей-иконка** (системный трей Windows): «Показать REDLINE Client»,
  «Проверить обновления», «GitHub Releases», «Выход»; двойной клик —
  показать окно.
- Тесты автообновления: \`test/updater.test.js\` (19 тестов, node --test).

Движки (официальные сборки, SHA-256 проверен при сборке):

- Xray v26.7.28 — Proxy-режим (SOCKS/HTTP + системный Proxy)
- Sing-box 1.13.19 — TUN CORE, рекомендуемый режим по умолчанию
- Flowseal Zapret 1.10.1 — DPI SHIELD (YouTube/Discord)

## Установка

1. Закройте старый REDLINE.Client.exe.
2. Замените старый файл новым (портабл-сборка, установщик не нужен).
3. Приложению нужны права администратора (UAC).
4. Без code signing: SmartScreen может показать «Подробнее» — для этого
   проекта это нормально.

## SHA-256

\`\`\`
$SHA256  REDLINE.Client.exe
\`\`\`

- Размер файла: $SIZE байт
- \`resources/app.asar\` (ветка): \`$ASAR_SHA\`
- Собирается из: ветка \`$BRANCH\`, коммит \`$COMMIT\`
EOF
)"

echo "==> Публикация GitHub-релиза $TAG"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Релиз $TAG существует — обновляю ассет и описание"
  gh release upload "$TAG" "$EXE" --clobber
  gh release edit "$TAG" --notes "$BODY"
else
  gh release create "$TAG" "$EXE" --title "$VERSION" --notes "$BODY" --verify
fi

echo "==> Готово: https://github.com/sv000-source/REDLINE-CLIENT/releases/tag/$TAG"
echo "SHA-256 REDLINE.Client.exe: $SHA256"
