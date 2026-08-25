# REDLINE Client — восстановление после сбоя (25.08.2026)

Сбой уничтожил рабочую среду разработки. В репозиторий REDLINE-CLIENT загружено
то, что осталось: распакованная Windows-сборка 1.8.1-beta (win-unpacked) и
полная история чата (`chat_history.txt`, 9012 строк). dev-проект
`/home/user/happ-redline-desktop` с тестами, package-lock и vendor-каталогами
не сохранился и восстановлен из этих источников в папку `happ-redline-desktop/`.

## Релиз v1.8.1-beta (дополнительные сохранённые данные)

В релизе https://github.com/sv000-source/REDLINE-CLIENT/releases лежит файл
`REDLINE.Client.exe` (235 533 824 байта), который не вошёл в репозиторий
(лимит GitHub — 100 МБ на файл). Среда разработки не имеет прямого доступа к
CDN GitHub (`release-assets/objects.githubusercontent.com`), поэтому файл
разбирается транспортным workflow на Actions-раннере, который коммитит
результаты в ветку `arena/01a03a78-redline-client` → `recovered/release-exe/`.

### Что установлено по итогам первого прогона (25.08.2026)

- `REDLINE.Client.exe` — **однофайловая портабл-сборка electron-builder**:
  PE32+ GUI x86-64, 15 секций, Electron 43.4.1 / Chrome 150.0.7871.224,
  version resource «REDLINE Client 1.8.1-beta» (Local Operator, ProductVersion
  1.8.1.0), SHA-256 `5657ac10efa033ce7cd1b9d28c62e6dcc6950082145d537a8afd58e2f3d4b6e1`.
- Payload (полный win-unpacked с app.asar и движками) сжат внутри секций
  (`.text` 186 МБ, `.rdata` 41 МБ; секции LZMADEC/CPADinfo/prot/malloc_h —
  самораспаковка), поэтому обычная распаковка 7z даёт только PE-ресурсы.
- **Иконка приложения извлечена** (была среди потерянных артефактов):
  `recovered/release-exe/pe-icons/REDLINE.Client.exe_14_1.ico` (37 КБ, все
  размеры) + `recovered/release-exe/icon-preview.png` (превью).
- В ресурсах есть `.rsrc/1033/INTEGRITY/ELECTRONASAR` — Electron asar
  integrity: содержит SHA-256 заголовка встроенного app.asar. Второй прогон
  (tools/recover-run.sh) сверяет его с заголовком `resources/app.asar` из
  репозитория и, при возможности, извлекает payload целиком.
- Хэш репозиторного `resources/app.asar`:
  SHA-256 `e768f344b4c6d4a89449e7f384e7bf871f10e2dc94907be84c403ee673691cce`
  (340 791 байт; заголовок = первые 5684 байта).

### Финальный вердикт по релизному asset (прогон 2, 25.08.2026)

**Встроенный app.asar ИДЕНТИЧЕН репозиторному.** Ресурс
`.rsrc/1033/INTEGRITY/ELECTRONASAR` = `[{"file":"resources\\app.asar",
"alg":"SHA256","value":"b8907d8e…e026"}]` совпал с SHA-256 заголовка
(`sha256_json_raw`) `resources/app.asar` из репозитория. Заголовок asar
содержит полный список файлов с размерами и смещениями — совпадение хэша
заголовка означает тот же самый asar.

Итого: `REDLINE.Client.exe` в релизе — это electron-builder портабл-сборка
той же версии 1.8.1-beta, код которой уже полностью восстановлен в
`happ-redline-desktop/`. Нового кода в нём нет; ценное, что из него взято —
иконка приложения. Payload сжат внутри секций EXE (маркеры приложения
`REDLINE`/`TUN CORE` в байтах не встречаются — всё упаковано), распаковка
его не требовалась.

### Сессия 3 (25.08.2026): 1.9.0-beta и сборка релиза

- User прислал задачу: patch-файл 1.9.0-beta (автообновление через GitHub
  Releases + трей) — **файл в песочницу не доставился** (проверен весь
  filesystem); реализация сделана по описанию и правилам проекта, расхождение
  зафиксировано (chat_history_2.txt, ХОД 6). Если patch пришлём повторно —
  ветка перезаписывается по нему.
- `happ-redline-desktop/` — 1.9.0-beta: `src/services/updater.js`, трей в
  `src/main.js`, строка «Обновления приложения» в настройках, тесты
  `test/updater.test.js` (19 PASS, `node --test`), package-lock.json.
- `resources/app.asar` пересобран под 1.9.0-beta: 397 701 байт,
  SHA-256 `85a64eb14caf23e7123b79407a447015bd517450e054fdc827a124ba54ed6a40`;
  хэш заголовка (значение ELECTRONASAR для будущего exe):
  `662f62f9f49f054b4c9e1616307f0f997b18f7729d23aa74a8d5a91aa1449b5f`.
- EXE в песочнице собрать **невозможно** (CDN objects.githubusercontent.com
  — SSL reset; подтверждено прогон electron-builder: «unable to verify the
  first certificate»; wine отсутствует). Сборка + публикация релиза
  v1.9.0-beta (REDLINE.Client.exe + SHA-256 в описании) — через Actions:
  `tools/build-release-win.sh` + диспетчер `tools/build-release-win.yml.txt`
  (пользователь кладёт на main как `build-release-win.yml` и жмёт Run
  workflow; раннер windows-latest, node 22, contents:write).

## Как устроен транспорт

Диспетчер `.github/workflows/recover-release-asset.yml` на `main` (создан
вручную пользователем — токен агента не имеет права workflows) только
запускает `bash tools/recover-run.sh` из ветки `arena/01a03a78-redline-client`.
Скрипт скачивает asset, делает forensic-разбор (ресурсы, ELECTRONASAR, скан
подписей 7z/zip/zstd, вырезание payload, wine-самораспаковка) и коммитит
итоги обратно в ветку. Запуск: Actions → Recover release asset → Run workflow
(или автоматически пушем tools/recover-run.sh, если push-триггер сработает).

## Что уцелело без потерь

| Что | Где | Состояние |
|---|---|---|
| Код приложения 1.8.1-beta (main, preload, renderer, 15 сервисов) | `resources/app.asar` → извлечён в `happ-redline-desktop/src/` | полный, синтаксис проверен `node --check` |
| Xray v26.7.28 + geoip/geosite + wintun.dll | `resources/xray/` | бандл не изменён, SHA-256 из истории совпадает |
| Sing-box 1.13.19 | `resources/sing-box/` | бандл не изменён |
| Flowseal Zapret 1.10.1 | `resources/zapret/` | бандл не изменён |
| Electron 43.4.1 (runtime, dll, locales ru/en) | корень репозитория | собранная сборка |
| История разработки 0.2.0 → 1.8.1-beta | `chat_history.txt` | полная |
| Скрипты загрузки движков | история → `happ-redline-desktop/scripts/` | восстановлены дословно |
| Лицензии third-party | `resources/*` → `happ-redline-desktop/third_party/` | восстановлены |

## Что потеряно окончательно (временно)

- **Тесты** — 15 файлов `test/*.test.js` (47 тестов, `node --test`). В истории
  сохранились только фрагменты. Нужно переписать заново по текущему коду.
  Обновлено (сессия 3, 25.08.2026): восстановлен `test/updater.test.js`
  (19 тестов для 1.9.0-beta); остальные 14 файлов — по-прежнему отсутствуют.
- **package-lock.json** — пересоздаётся `npm install`.
  Обновлено (сессия 3): воссоздан и закоммичен (happ-redline-desktop/).
- **Иконка приложения / build-ресурсы electron-builder** (иконка exe).
  Обновлено (сессия 3): иконка в `happ-redline-desktop/build/icon.ico`
  (из `recovered/release-exe/pe-icons/`), кэш для трей-иконки —
  `happ-redline-desktop/src/assets/icon-{ico,32.png}`.
- **Готовые архивы** 1.8.1-beta (7z, source.zip, BUILD-INFO) — не критично,
  собираются заново.
- **xray-legacy.exe v26.1.23** (compatibility-core для `insecure=1` в режиме
  XRAY из 1.3.1-beta) — в сборку 1.8.1-beta не входил (решение того времени:
  `insecure=1` обслуживает TUN CORE). Код XrayManager его по-прежнему
  поддерживает — достаточно положить exe в `vendor/xray/windows-x64`.
- **package.json (dev-конфиг)** — восстановлен по истории (версия 0.4.0) с
  приведением к финальной процедуре сборки (`--win dir`, requireAdministrator,
  extraResources → xray/sing-box/zapret). Мелкие отличия от утраченного
  оригинала возможны.

## Памятка проекта (правила, собранные из истории)

1. Версия всегда в формате `1.x.x-beta`, bump при любом изменении.
2. Никаких встроенных серверов и чужих подписок — только подписки,
   добавленные пользователем вручную.
3. Честный User-Agent `REDLINE-Client/<version>`; не маскироваться под
   Misetanibox / FlClashX / Koala Clash / Prizrak-Box.
4. `happ://crypt*` ссылки намеренно не поддерживаются; схема `happ://`
   отключена с 1.1, работает только `redline://`.
5. Интерфейс упрощённый (с 1.6.0): не возвращать библиотеку приложений,
   мониторинг CPU/RAM/адаптеров и QUICK START без явной просьбы.
6. TUN CORE (Sing-box) — рекомендуемый режим по умолчанию; DPI SHIELD —
   YouTube/Discord; XRAY — Proxy-режим.
7. HWID отправляется только при включённой галочке у конкретной подписки.
8. При пересборке: `npm run prepare:engines` → `npx electron-builder --win
   dir --x64` → ручное 7z-архивирование (portable с -mx=9 падал).

## Хронология версий (из истории)

0.2.0–0.5.0 → 1.0.1-beta (Node → Electron, crypt5-совместимость) →
1.0.2-beta → 1.1.0-beta (отключение happ://) → 1.2.0-beta → 1.3.0-beta
(HWID) → 1.3.1-beta (dual Xray core для insecure=1) → 1.4.0-beta (HWID opt-in
per subscription) → 1.5.0-beta (Sing-box TUN) → 1.5.1-beta (фикс DNS: hijack +
DoH через proxy) → 1.6.0-beta (упрощение UI) → 1.6.1-beta → 1.7.0-beta
(соглашение, онбординг, логотипы движков) → 1.8.0-beta (выбор подписки→узел,
группировка, заметки, аварийный сброс) → 1.8.1-beta (плашка Telegram-ботов:
@AccarTunnelBot @perec @maxvpnonlinebot @abs_vpnbot @Geodema_bot) →
**1.9.0-beta (автообновление через GitHub Releases + трей-иконка; тесты
updater)**.

## Открытые вопросы на момент сбоя (последние сообщения пользователя, ответов не было)

1. **Android-версия** — пользователь спросил «возможно ли сделать версию для
   андроид» и просил задать 4 уточняющих вопроса.
2. **Автообновление приложения** — РЕАЛИЗОВАНО в 1.9.0-beta (сессия 3):
   `happ-redline-desktop/src/services/updater.js` + кнопка в настройках +
   трей; завязка на GitHub Releases (`sv000-source/REDLINE-CLIENT`), честный
   UA, установка ручная (замена portable-EXE, сверка SHA-256).

## Известные нерешённые проблемы (из финальной сводки истории)

- Geodema отвечал «App not supported»: провайдер требует HWID (реализован) и,
  возможно, whitelist User-Agent. План: попросить поддержку провайдера
   разрешить `REDLINE-Client/1.8.1-beta (Windows x64; HWID)`. Не спуфить.
- Опубликованный ранее Geodema-токен скомпрометирован — перевыпустить.
- Нет code signing: SmartScreen может предупреждать; WinDivert может
  детектиться как RiskTool/PUA.
- Сборка не запускалась как Windows GUI в Linux-песочнице — проверялись
  только содержимое пакета, asar, тесты и integrity.
