# REDLINE Client — восстановление после сбоя (25.08.2026)

Сбой уничтожил рабочую среду разработки. В репозиторий REDLINE-CLIENT загружено
то, что осталось: распакованная Windows-сборка 1.8.1-beta (win-unpacked) и
полная история чата (`chat_history.txt`, 9012 строк). dev-проект
`/home/user/happ-redline-desktop` с тестами, package-lock и vendor-каталогами
не сохранился и восстановлен из этих источников в папку `happ-redline-desktop/`.

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
- **package-lock.json** — пересоздаётся `npm install`.
- **Иконка приложения / build-ресурсы electron-builder** (иконка exe).
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
группировка, заметки, аварийный сброс) → **1.8.1-beta (плашка Telegram-ботов:
@AccarTunnelBot @perec @maxvpnonlinebot @abs_vpnbot @Geodema_bot)**.

## Открытые вопросы на момент сбоя (последние сообщения пользователя, ответов не было)

1. **Android-версия** — пользователь спросил «возможно ли сделать версию для
   андроид» и просил задать 4 уточняющих вопроса.
2. **Автообновление приложения** — пользователь предлагает обновление по кнопке
   в настройках, выложенной им самим сборки, с завязкой на GitHub; просил
   задать 20 вопросов, в последнем — решение «делаем или нет».

## Известные нерешённые проблемы (из финальной сводки истории)

- Geodema отвечал «App not supported»: провайдер требует HWID (реализован) и,
  возможно, whitelist User-Agent. План: попросить поддержку провайдера
   разрешить `REDLINE-Client/1.8.1-beta (Windows x64; HWID)`. Не спуфить.
- Опубликованный ранее Geodema-токен скомпрометирован — перевыпустить.
- Нет code signing: SmartScreen может предупреждать; WinDivert может
  детектиться как RiskTool/PUA.
- Сборка не запускалась как Windows GUI в Linux-песочнице — проверялись
  только содержимое пакета, asar, тесты и integrity.
