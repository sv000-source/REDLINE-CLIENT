# REDLINE Client (happ-redline-desktop)

RED TEAM Windows-клиент для собственных подписок пользователя: Xray Proxy,
Sing-box TUN и Flowseal DPI Shield в одном интерфейсе.

Текущая версия: **1.9.0-beta**. Схема версий: при любом изменении — bump до
следующей `1.x.x-beta`.

## 1.9.0-beta

- Автообновление через GitHub Releases (`src/services/updater.js`): проверка
  свежих опубликованных релизов `sv000-source/REDLINE-CLIENT` по
  `api.github.com` — при запуске (тихо, статус в трей-иконке и в настройках)
  и вручную (кнопка «Проверить» в настройках / пункт меню трея). Честный
  User-Agent `REDLINE-Client/<version>`, один GET-запрос на проверку, без
  телеметрии. Установка — ручная: релизный `REDLINE.Client.exe` заменяется на
  новый, SHA-256 сверяется по описанию релиза.
- Трей-иконка (системный трей Windows): «Показать REDLINE Client»,
  «Проверить обновления», «GitHub Releases», «Выход»; двойной клик — показать
  окно. Закрываемое приложение как раньше: «Выход» прогоняет штатную
  последовательность остановки движков.
- Тесты `test/updater.test.js` (`node --test`).

## Возможности

- TUN CORE (Sing-box 1.13.19) — полноценный VPN: TCP/UDP/QUIC/DNS, DNS hijack,
  DoH через proxy outbound, strict_route. Рекомендуемый режим.
- XRAY (Xray v26.7.28) — локальные SOCKS/HTTP-порты + системный Proxy Windows.
  TLS-ссылки с `insecure=1` обслуживаются только через TUN CORE — современный
  Xray удалил allowInsecure (XrayManager также поддерживает опциональный
  `xray-legacy.exe` v26.1.23, если положить его в `vendor/xray/windows-x64`).
- DPI SHIELD (Flowseal zapret-discord-youtube 1.10.1) — обход DPI для
  YouTube/Discord, выбор стратегии, диагностика.
- Подписки: только добавленные пользователем (URL / буфер / файл),
  личные заметки до 500 символов, HWID opt-in на каждую подписку отдельно,
  честный User-Agent `REDLINE-Client/<version>` (без подмены чужих клиентов).
- Импорт по deep link `redline://` (схема `happ://` намеренно отключена с 1.1;
  зашифрованные `happ://crypt*` ссылки не поддерживаются).
- Интерфейс: упрощённый (с 1.6.0) — центр управления, узлы, подписки, журнал,
  настройки, питание; темы REDLINE / MATRIX / CYBER VOID / AMBER OPS;
  PRO-режим; соглашение и 4-шаговый онбординг; опциональный пароль;
  аварийный сброс сети; контроль питания Windows.
- Хранилище: DPAPI/safeStorage, HWID — SHA-256 от аппаратных идентификаторов
  (MachineGuid, ProcessorId, серийный номер и модель материнской платы, BIOS),
  серийники не сохраняются и не отправляются.

Чего в приложении нет и не будет: встроенных VPN-серверов, предустановленных
чужих подписок, спуфинга User-Agent других клиентов.

## Сборка (Windows x64)

Требуется Node.js 22.12+.

```text
npm install
npm run prepare:engines   # скачать официальные Xray / Sing-box / Zapret с проверкой SHA-256
npm test                  # тесты
npx electron-builder --win dir --x64
```

Релизный однофайловый `REDLINE.Client.exe` (как в релизах GitHub):

```text
npx electron-builder --win portable --x64   # -> release/REDLINE.Client.exe
```

Иконка EXE — `build/icon.ico` (извлечена из релизного EXE 1.8.1-beta, см.
`../recovered/release-exe/pe-icons/`). Готовая распакованная сборка:
`release/win-unpacked/` (`REDLINE Client.exe`, требует администратора).
Архивировать вручную:

```text
cd release/win-unpacked
7z a -t7z -mx=9 -m0=lzma2 -md=32m -mmt=1 REDLINE-Client-<version>-Windows-x64.7z .
```

Исходники в архив/репозиторий не включают `node_modules`, `release`, `vendor`.

## Лицензии

- Код приложения: MIT (см. LICENSE).
- Xray-core — MIT; Wintun — Apache-2.0 / Wine HQ LLGPL.
- sing-box — GPL-3.0-or-later.
- Flowseal zapret-discord-youtube — MIT (Flowseal); WinDivert — LGPL/GPL
  (Flowseal). См. `third_party/`.

## Восстановление после сбоя

Этот проект восстановлен из собранного `app.asar` 1.8.1-beta и
`chat_history.txt`. Что уцелело и что потерялось — см. `../RECOVERY-NOTES-RU.md`
в корне репозитория.
