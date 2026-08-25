(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const model = {
    snapshot: { version: 1, security: { encrypted: false }, subscriptions: [] },
    pings: new Map(),
    selectedSubscriptionId: '',
    selectedNodeId: '',
    nodeFilter: 'all',
    importType: 'url',
    logs: [],
    activeEngine: localStorage.getItem('redline-engine') || 'singbox',
    theme: localStorage.getItem('redline-theme') || 'redline',
    uiMode: localStorage.getItem('redline-ui-mode') || 'pro',
    xray: { available: false, state: 'stopped', core: { available: false, version: '' } },
    singbox: { available: false, state: 'stopped', core: { available: false, version: '' }, mixedPort: null, interfaceName: 'REDLINE-TUN' },
    zapret: { available: false, state: 'stopped', profiles: [], profileId: '', profileName: '' },
    powerCountdownCancelled: false,
    passwordRequired: false,
    authResolve: null,
    firstRunResolve: null,
    onboardingIndex: 0,
    osInfo: null,
    protocols: { redline: false, happ: false },
    deepLink: null,
    deepLinkQueue: []
  };

  function makeSvg(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function formatDate(value) {
    if (!value) return 'Никогда';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Неизвестно';
    return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  const onboardingSteps = [
    { title: 'Обзор', subtitle: 'Главный экран управления REDLINE', icon: 'i-grid', points: ['Выберите TUN CORE, DPI SHIELD или XRAY.', 'Для полноценного VPN используйте TUN CORE — он отмечен как рекомендуемый.', 'Большая кнопка START/STOP управляет выбранным движком.'] },
    { title: 'Узлы', subtitle: 'Выбор сервера и проверка доступности', icon: 'i-server', points: ['Откройте раздел «Узлы» после импорта подписки.', 'Запустите ping одного узла или проверку всего списка.', 'Выберите сервер перед запуском TUN или Xray.'] },
    { title: 'Подписки', subtitle: 'Только ваши открытые источники', icon: 'i-link', points: ['Добавьте HTTPS URL, Base64, share-ссылку или локальный файл.', 'Сохраните личную заметку об источнике и включайте HWID только при необходимости.', 'После обновления REDLINE автоматически проверит полученные узлы.'] },
    { title: 'Безопасный запуск', subtitle: 'Питание, журнал и настройки', icon: 'i-shield', points: ['Журнал показывает реальные ошибки Sing-box, Xray и Zapret.', 'Сон, перезагрузка и выключение имеют 10-секундную отмену.', 'Пароль запуска, темы и автозапуск находятся в настройках.'] }
  ];

  function applyOsBranding(system = {}) {
    model.osInfo = system;
    const isWin10 = String(system.label || '').includes('10');
    for (const id of ['auth-windows-mark', 'first-run-windows-mark']) {
      const mark = $(`#${id}`); mark?.classList.toggle('win10', isWin10); mark?.classList.toggle('win11', !isWin10);
    }
    const title = String(system.label || 'Windows 11').toUpperCase();
    $('#auth-os-title').textContent = title; $('#first-run-os-title').textContent = title;
    const build = `${String(system.arch || 'x64').toUpperCase()} // BUILD ${system.release || 'NATIVE'}`;
    $('#auth-os-build').textContent = `SECURE OPERATOR AUTHENTICATION // ${build}`;
    $('#first-run-os-build').textContent = build;
  }

  function renderOnboardingStep() {
    const step = onboardingSteps[model.onboardingIndex];
    $('#onboarding-step-label').textContent = `STEP ${String(model.onboardingIndex + 1).padStart(2, '0')} / 04`;
    $('#onboarding-title').textContent = step.title; $('#onboarding-subtitle').textContent = step.subtitle;
    $('#onboarding-symbol').querySelector('use').setAttribute('href', `#${step.icon}`);
    const list = $('#onboarding-points'); list.replaceChildren(); for (const point of step.points) list.append(make('li', '', point));
    $$('#onboarding-dots i').forEach((dot, index) => dot.classList.toggle('active', index === model.onboardingIndex));
    $('#onboarding-back').disabled = model.onboardingIndex === 0;
    $('#onboarding-next').textContent = model.onboardingIndex === onboardingSteps.length - 1 ? 'Завершить' : 'Далее';
  }

  function beginOnboarding() {
    $('#agreement-screen').hidden = true; $('#onboarding-screen').hidden = false; model.onboardingIndex = 0; renderOnboardingStep();
  }

  async function finishFirstRun() {
    await api.security.completeOnboarding();
    $('#first-run-overlay').classList.remove('open'); $('#first-run-overlay').setAttribute('aria-hidden', 'true');
    model.firstRunResolve?.(); model.firstRunResolve = null;
  }

  async function runFirstRunIfNeeded(status) {
    applyOsBranding(status.system || {});
    if (status.agreementAccepted && status.onboardingComplete) return;
    $('#first-run-overlay').classList.add('open'); $('#first-run-overlay').setAttribute('aria-hidden', 'false');
    $('#agreement-screen').hidden = Boolean(status.agreementAccepted); $('#onboarding-screen').hidden = !status.agreementAccepted;
    if (status.agreementAccepted) beginOnboarding();
    await new Promise(resolve => { model.firstRunResolve = resolve; });
  }

  function browserAdapter() {
    document.body.classList.add('browser-preview');
    const key = 'redline-browser-preview-v1';
    const blank = { version: 1, security: { encrypted: false }, subscriptions: [] };
    const load = () => {
      try { return JSON.parse(localStorage.getItem(key)) || structuredClone(blank); }
      catch (_) { return structuredClone(blank); }
    };
    const save = snapshot => localStorage.setItem(key, JSON.stringify(snapshot));

    function parsePreview(content) {
      let text = String(content || '').trim();
      if (!text.includes('://')) {
        try { text = atob(text.replace(/-/g, '+').replace(/_/g, '/')); } catch (_) { /* Keep original. */ }
      }
      const servers = [];
      for (const raw of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        try {
          let protocol = raw.split('://')[0].toLowerCase();
          let name = '';
          let host = '';
          let port = 443;
          let transport = '';
          let security = '';
          if (protocol === 'vmess') {
            const data = JSON.parse(atob(raw.slice(8).replace(/-/g, '+').replace(/_/g, '/')));
            host = data.add; port = Number(data.port) || 443; name = data.ps || ''; transport = data.net || ''; security = data.tls || '';
          } else if (protocol === 'ss') {
            const body = raw.slice(5).split('#')[0];
            const endpoint = body.includes('@') ? body : atob(body.split('?')[0]);
            const hostPort = endpoint.slice(endpoint.lastIndexOf('@') + 1);
            const cut = hostPort.lastIndexOf(':'); host = hostPort.slice(0, cut); port = Number(hostPort.slice(cut + 1)) || 8388;
            name = decodeURIComponent((raw.split('#')[1] || ''));
            protocol = 'shadowsocks';
          } else {
            const url = new URL(raw);
            host = url.hostname; port = Number(url.port) || 443; name = decodeURIComponent(url.hash.slice(1));
            transport = url.searchParams.get('type') || ''; security = url.searchParams.get('security') || '';
            if (protocol === 'hy2') protocol = 'hysteria2';
          }
          if (host) servers.push({ id: crypto.randomUUID(), name: name || `${protocol.toUpperCase()} · ${host}`, protocol, host, port, transport, security, sni: '' });
        } catch (_) { /* Unsupported lines are ignored in browser preview only. */ }
      }
      if (!servers.length) throw new Error('Не найдено поддерживаемых ссылок');
      return servers;
    }

    return {
      isDesktop: false,
      appInfo: async () => ({ version: '1.8.1-beta-preview', platform: 'browser', arch: 'preview', encryptedStorage: false }),
      appLifecycle: { confirmClose: async () => {}, onShutdownRequest: () => () => {} },
      security: { status: async () => ({ required: false, unlocked: true, agreementAccepted: true, onboardingComplete: true, system: { label: 'Windows 11', arch: 'x64', release: '10.0.22631' } }), acceptAgreement: async () => ({ agreementAccepted: true }), completeOnboarding: async () => ({ onboardingComplete: true }), resetOnboarding: async () => ({ onboardingComplete: false }), verify: async () => ({ required: false, unlocked: true }), setPassword: async () => ({ required: true, unlocked: true }), removePassword: async () => ({ required: false, unlocked: true }) },
      system: { power: async () => ({}), emergencyReset: async () => ({ ok: true, report: ['Preview reset'] }), autostartStatus: async () => ({ enabled: false, supported: false }), setAutostart: async () => ({ enabled: false, supported: false }) },
      subscriptions: {
        list: async () => load(),
        addUrl: async () => { throw new Error('Реальная загрузка URL доступна в нативной Windows-сборке. В preview вставьте текст подписки.'); },
        addContent: async payload => {
          const snapshot = load();
          const servers = parsePreview(payload.content);
          const subscription = { id: crypto.randomUUID(), name: payload.name || 'Preview subscription', sourceType: 'text', sourceHost: 'browser preview', note: payload.note || '', hasRemoteUrl: false, autoUpdate: false, createdAt: new Date().toISOString(), lastUpdated: new Date().toISOString(), updateError: '', parseWarnings: 0, serverCount: servers.length, servers: [] };
          subscription.servers = servers.map(server => ({ ...server, subscriptionId: subscription.id, subscriptionName: subscription.name }));
          snapshot.subscriptions.push(subscription); save(snapshot);
          return { subscription, snapshot };
        },
        importFile: async () => { throw new Error('Выбор файла работает в нативной Windows-сборке.'); },
        update: async () => { throw new Error('Обновление по сети работает только в нативной сборке.'); },
        updateAll: async () => { throw new Error('Обновление по сети работает только в нативной сборке.'); },
        remove: async id => { const snapshot = load(); const index = snapshot.subscriptions.findIndex(item => item.id === id); const removed = snapshot.subscriptions.splice(index, 1)[0]; save(snapshot); return { removed, snapshot }; },
        setHwid: async () => { throw new Error('HWID доступен только в Windows-сборке.'); }
      },
      deepLinks: { accept: async () => { throw new Error('Deep link доступен только в Windows-приложении.'); }, reject: async () => ({}), onRequest: () => () => {}, onError: () => () => {} },
      nodes: { ping: async () => { throw new Error('TCP/ICMP ping выполняется только нативным приложением, не браузерным preview.'); } },
      singbox: {
        status: async () => ({ available: false, state: 'stopped', core: { available: false, version: '' } }),
        start: async () => { throw new Error('Sing-box TUN доступен только в Windows-сборке.'); },
        stop: async () => ({ available: false, state: 'stopped' }),
        onEvent: () => () => {}
      },
      zapret: {
        status: async () => ({ available: false, state: 'stopped', profiles: [] }),
        start: async () => { throw new Error('DPI bypass запускается только в Windows-приложении.'); },
        stop: async () => ({ available: false, state: 'stopped' }),
        test: async () => { throw new Error('Диагностика доступна только в Windows-приложении.'); },
        onEvent: () => () => {}
      },
      xray: {
        status: async () => ({ available: false, state: 'stopped', core: { available: false, version: '' } }),
        start: async () => { throw new Error('Xray запускается только в нативной Windows-сборке.'); },
        stop: async () => ({ available: false, state: 'stopped' }),
        onEvent: () => () => {}
      },
      window: {
        minimize: async () => {}, maximize: async () => {}, close: async () => {}, exitFullscreen: async () => false, enterFullscreen: async () => true, isFullscreen: async () => false,
        zoom: async action => {
          const current = Number(document.documentElement.dataset.zoom || 100);
          const next = action === 'in' ? Math.min(150, current + 10) : action === 'out' ? Math.max(75, current - 10) : 100;
          document.documentElement.dataset.zoom = String(next);
          document.documentElement.style.zoom = `${next}%`;
          return next;
        }, onMaximized: () => () => {}
      }
    };
  }

  const api = window.redline || browserAdapter();

  function toast(title, message, type = 'info') {
    const item = make('div', 'toast');
    const icon = make('span', 'toast-icon');
    icon.append(makeSvg(type === 'error' ? 'i-activity' : type === 'secure' ? 'i-shield' : 'i-check'));
    const body = make('div');
    body.append(make('strong', '', title), make('small', '', message));
    item.append(icon, body);
    $('#toast-stack').append(item);
    setTimeout(() => item.classList.add('out'), 3600);
    setTimeout(() => item.remove(), 3900);
  }

  function addLog(level, source, message) {
    const now = new Date();
    const entry = { level: level.toLowerCase(), source, message, time: now.toLocaleTimeString('ru-RU', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0') };
    model.logs.push(entry);
    if (model.logs.length > 500) model.logs.shift();
    renderLogs();
    addEvent(level, source, message);
  }

  function addEvent(level, title, message) {
    const list = $('#event-list');
    const event = make('div', 'event');
    const icon = make('span', `event-icon ${level === 'error' ? 'warn' : level === 'info' ? 'ok' : ''}`);
    icon.append(makeSvg(level === 'error' ? 'i-activity' : level === 'warn' ? 'i-shield' : 'i-check'));
    const body = make('div'); body.append(make('strong', '', title), make('p', '', message));
    const time = make('time', '', new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    event.append(icon, body, time); list.prepend(event);
    while (list.children.length > 4) list.lastElementChild.remove();
  }

  function renderLogs() {
    const terminal = $('#terminal');
    const prompt = $('.terminal-prompt', terminal);
    const search = ($('#log-search')?.value || '').toLowerCase();
    const active = $('.log-levels button.active')?.dataset.logFilter || 'all';
    $$(':scope > div[data-level]', terminal).forEach(line => line.remove());
    for (const entry of model.logs) {
      if (active !== 'all' && entry.level !== active) continue;
      if (search && !`${entry.source} ${entry.message}`.toLowerCase().includes(search)) continue;
      const line = make('div'); line.dataset.level = entry.level;
      line.append(make('time', '', entry.time), make('b', entry.level, entry.level.toUpperCase()), make('span', '', `[${entry.source}] ${entry.message}`));
      terminal.insertBefore(line, prompt);
    }
    $('#log-count').textContent = `${model.logs.length} EVENTS`;
    terminal.scrollTop = terminal.scrollHeight;
  }

  function allNodes() { return model.snapshot.subscriptions.flatMap(subscription => subscription.servers || []); }
  function selectedSubscription() { return model.snapshot.subscriptions.find(subscription => subscription.id === model.selectedSubscriptionId) || model.snapshot.subscriptions[0] || null; }
  function nodesForSelectedSubscription() { return selectedSubscription()?.servers || []; }
  function selectedNode() { const scoped = nodesForSelectedSubscription(); return scoped.find(node => node.id === model.selectedNodeId) || scoped[0] || null; }

  function pingState(nodeId) { return model.pings.get(nodeId) || { state: 'idle', latency: null, method: '' }; }

  function applySnapshot(snapshot) {
    model.snapshot = snapshot || { version: 1, security: { encrypted: false }, subscriptions: [] };
    const subscriptions = model.snapshot.subscriptions;
    if (!subscriptions.some(subscription => subscription.id === model.selectedSubscriptionId)) model.selectedSubscriptionId = subscriptions[0]?.id || '';
    const scopedNodes = nodesForSelectedSubscription();
    if (!scopedNodes.some(node => node.id === model.selectedNodeId)) model.selectedNodeId = scopedNodes[0]?.id || '';
    renderEverything();
  }

  const powerLabels = { sleep: 'ПЕРЕХОД В СОН', restart: 'ПЕРЕЗАГРУЗКА', shutdown: 'ВЫКЛЮЧЕНИЕ' };
  async function runPowerCountdown(action) {
    if (!powerLabels[action]) return;
    model.powerCountdownCancelled = false; model.powerAction = action;
    openConnectionTerminal(`power --${action} --countdown=10`, 'POWER CONTROL');
    $('#terminal-close').disabled = false; $('#terminal-close').textContent = 'ОТМЕНА';
    terminalLine('warn', `${powerLabels[action]} запланировано. Можно отменить.`, 5);
    for (let seconds = 10; seconds > 0; seconds -= 1) {
      if (model.powerCountdownCancelled) { terminalLine('cancel', 'Команда питания отменена оператором', 0); model.powerAction = ''; $('#terminal-close').textContent = 'ЗАКРЫТЬ'; await wait(350); closeConnectionTerminal(); return; }
      $('#terminal-command').textContent = `${action.toUpperCase()} IN ${seconds}`;
      $('#terminal-stage').textContent = `T-${String(seconds).padStart(2, '0')}`;
      $('#terminal-progress-bar').style.width = `${(10 - seconds) * 10}%`;
      $('#terminal-progress-text').textContent = `${seconds} секунд · нажмите ОТМЕНА для отмены`;
      await wait(1000);
    }
    model.powerAction = ''; $('#terminal-close').disabled = true; $('#terminal-close').textContent = 'ВЫПОЛНЕНИЕ';
    terminalLine('exec', `EXECUTING ${powerLabels[action]}`, 100);
    try { await api.system.power(action); }
    catch (error) { terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message); }
  }

  function renderEverything() {
    renderOverview(); renderNodes(); renderSubscriptions(); renderSecurity();
  }

  function renderOverview() {
    const subs = model.snapshot.subscriptions;
    const nodes = allNodes();
    const successful = [...model.pings.values()].filter(item => item.ok);
    const average = successful.length ? Math.round(successful.reduce((sum, item) => sum + item.latency, 0) / successful.length) : null;
    const current = selectedNode();

    $('#nav-node-count').textContent = String(nodes.length);
    $('#nav-sub-count').textContent = String(subs.length);
    $('#inventory-node-count').textContent = String(nodes.length);
    $('#inventory-sub-count').textContent = String(subs.length);
    $('#inventory-online-count').textContent = model.pings.size ? String(successful.length) : '—';
    $('#metric-sub-count').textContent = String(subs.length);
    $('#metric-latency').textContent = average === null ? '—' : String(average);
    $('#all-node-count').textContent = String(nodes.length);
    const latestPing = [...model.pings.values()].map(value => value.checkedAt).filter(Boolean).sort().at(-1);
    $('#inventory-ping-time').textContent = latestPing ? formatDate(latestPing) : 'НИКОГДА';

    $$('#engine-selector button').forEach(button => button.classList.toggle('active', button.dataset.engine === model.activeEngine));
    $$('[data-engine-spec]').forEach(spec => spec.classList.toggle('active', spec.dataset.engineSpec.split(/\s+/).includes(model.activeEngine)));

    const xrayBusy = ['starting', 'stopping'].includes(model.xray.state);
    const xrayRunning = model.xray.state === 'running';
    const tunBusy = ['starting', 'stopping'].includes(model.singbox.state);
    const tunRunning = model.singbox.state === 'running';
    const lockedSelection = xrayRunning || xrayBusy || tunRunning || tunBusy;
    const subscriptionSelect = $('#active-subscription-select');
    subscriptionSelect.replaceChildren();
    if (!subs.length) { const option = make('option', '', 'НЕТ ПОДПИСОК'); option.value = ''; subscriptionSelect.append(option); }
    for (const subscription of subs) { const option = make('option', '', `${subscription.name} · ${subscription.serverCount} узлов${subscription.note ? ' · есть заметка' : ''}`); option.value = subscription.id; subscriptionSelect.append(option); }
    subscriptionSelect.value = model.selectedSubscriptionId || '';
    subscriptionSelect.disabled = lockedSelection || !subs.length;
    const nodeSelect = $('#active-node-select'); nodeSelect.replaceChildren();
    const scopedNodes = nodesForSelectedSubscription();
    if (!scopedNodes.length) { const option = make('option', '', 'НЕТ УЗЛОВ'); option.value = ''; nodeSelect.append(option); }
    for (const node of scopedNodes) { const ping = pingState(node.id); const option = make('option', '', `${node.name}${ping.ok ? ` · ${ping.latency} ms` : ''}`); option.value = node.id; nodeSelect.append(option); }
    nodeSelect.value = model.selectedNodeId || '';
    nodeSelect.disabled = lockedSelection || !scopedNodes.length;
    const pingButton = $('#ping-selected');
    const result = current ? pingState(current.id) : null;
    pingButton.replaceChildren(document.createTextNode(result?.state === 'running' ? 'ПРОВЕРКА…' : result?.ok ? `${result.latency} MS · ${result.method}` : current ? 'ЗАПУСТИТЬ PING' : 'PING НЕДОСТУПЕН'), makeSvg('i-activity'));
    pingButton.disabled = !current || result?.state === 'running' || xrayBusy || tunBusy;

    const profileSelect = $('#zapret-profile');
    if (model.zapret.profileId && model.zapret.state === 'running') profileSelect.value = model.zapret.profileId;
    profileSelect.disabled = ['running', 'starting', 'stopping'].includes(model.zapret.state);
    $('#zapret-test').disabled = model.zapret.state !== 'running';

    const engineState = model.activeEngine === 'zapret' ? model.zapret.state : model.activeEngine === 'singbox' ? model.singbox.state : model.xray.state;
    const running = engineState === 'running';
    const busy = engineState === 'starting' || engineState === 'stopping';
    document.body.classList.toggle('connected', running);
    document.body.classList.toggle('connecting', engineState === 'starting');
    document.body.classList.toggle('xray-error', engineState === 'error');

    const power = $('#power-button');
    const canStartZapret = model.zapret.available && api.isDesktop;
    const canStartXray = current && model.xray.available && api.isDesktop;
    const canStartSingbox = current && model.singbox.available && api.isDesktop;
    const canStartActive = model.activeEngine === 'zapret' ? canStartZapret : model.activeEngine === 'singbox' ? canStartSingbox : canStartXray;
    power.disabled = busy || (!running && !canStartActive);
    $('#power-label').textContent = running ? 'STOP' : busy ? 'WAIT' : 'START';

    if (model.activeEngine === 'zapret') {
      $('#power-detail').textContent = running ? 'DPI ACTIVE' : 'DPI SHIELD';
      $('#core-state-label').textContent = running ? `${model.zapret.profileName || 'GENERAL'} · WINWS ACTIVE` : busy ? 'DEPLOYING FILTERS' : model.zapret.available ? 'WINDIVERT READY' : 'ENGINE MISSING';
      if (running) {
        $('#status-kicker').textContent = 'DPI SHIELD АКТИВЕН';
        $('#status-title').textContent = 'YouTube и Discord разблокированы';
        $('#status-description').textContent = `Стратегия ${model.zapret.profileName || 'GENERAL'} перехватывает QUIC/TLS и Discord UDP/STUN локально, без VPN-сервера.`;
      } else if (busy) {
        $('#status-kicker').textContent = engineState === 'starting' ? 'РАЗВЁРТЫВАНИЕ DPI-КОНТУРА' : 'ВЫГРУЗКА WINDIVERT';
        $('#status-title').textContent = engineState === 'starting' ? 'Компиляция сетевой матрицы…' : 'Остановка winws…';
        $('#status-description').textContent = 'Не закрывайте окно UAC. Терминал показывает реальные этапы запуска.';
      } else if (!model.zapret.available) {
        $('#status-kicker').textContent = 'DPI ENGINE НЕДОСТУПЕН';
        $('#status-title').textContent = 'Flowseal Zapret не найден';
        $('#status-description').textContent = 'Используйте полную Windows-сборку REDLINE с папкой resources/zapret.';
      } else {
        $('#status-kicker').textContent = engineState === 'error' ? 'ПОСЛЕДНИЙ ЗАПУСК ЗАВЕРШИЛСЯ ОШИБКОЙ' : 'DPI SHIELD ГОТОВ';
        $('#status-title').textContent = 'Обход для YouTube и Discord';
        $('#status-description').textContent = 'Выберите стратегию и нажмите START. Windows запросит права администратора для загрузки WinDivert.';
      }
    } else if (model.activeEngine === 'singbox') {
      $('#power-detail').textContent = running ? 'TUN + PROXY ACTIVE' : 'SING-BOX TUN';
      $('#core-state-label').textContent = running ? `${model.singbox.interfaceName || 'REDLINE-TUN'} · MIXED ${model.singbox.mixedPort}` : busy ? 'TUN ROUTE TRANSITION' : model.singbox.available ? 'SING-BOX READY' : 'CORE MISSING';
      if (running) {
        $('#status-kicker').textContent = 'ПОЛНЫЙ TUN АКТИВЕН';
        $('#status-title').textContent = 'TCP, UDP, QUIC и DNS в туннеле';
        $('#status-description').textContent = `Sing-box auto_route + strict_route направляет весь компьютер через ${model.singbox.serverName || current?.name}. Mixed Proxy: 127.0.0.1:${model.singbox.mixedPort}.`;
      } else if (busy) {
        $('#status-kicker').textContent = engineState === 'starting' ? 'СОЗДАНИЕ TUN-АДАПТЕРА' : 'ВОССТАНОВЛЕНИЕ МАРШРУТОВ';
        $('#status-title').textContent = engineState === 'starting' ? 'Поднимается REDLINE-TUN…' : 'Остановка Sing-box…';
        $('#status-description').textContent = 'Не закрывайте приложение до завершения изменения таблицы маршрутизации.';
      } else if (!model.singbox.available) {
        $('#status-kicker').textContent = 'SING-BOX НЕДОСТУПЕН';
        $('#status-title').textContent = 'TUN core отсутствует';
        $('#status-description').textContent = 'Используйте полную сборку с resources/sing-box.';
      } else if (!nodes.length) {
        $('#status-kicker').textContent = 'НЕТ УЗЛА ДЛЯ TUN';
        $('#status-title').textContent = 'Добавьте открытую подписку';
        $('#status-description').textContent = 'TUN использует выбранный VLESS, VMess, Trojan, Shadowsocks, Hysteria2 или SOCKS узел.';
      } else {
        $('#status-kicker').textContent = 'TUN + MIXED PROXY ГОТОВЫ';
        $('#status-title').textContent = 'Полный VPN-режим Sing-box';
        $('#status-description').textContent = 'Выберите узел и нажмите START. REDLINE перехватит TCP, UDP, QUIC и DNS через TUN.';
      }
    } else {
      $('#power-detail').textContent = running ? (model.xray.systemProxy ? 'SYSTEM PROXY' : 'LOCAL PROXY') : 'XRAY PROXY';
      $('#core-state-label').textContent = running ? `${model.xray.coreMode === 'compat-insecure' ? 'COMPAT TLS' : 'MODERN'} · SOCKS ${model.xray.socksPort} · HTTP ${model.xray.httpPort}` : busy ? 'CORE TRANSITION' : model.xray.available ? 'CORE READY' : 'CORE MISSING';
      $('#system-proxy-toggle').disabled = running || busy;
      if (running) {
        $('#status-kicker').textContent = 'ЗАЩИЩЁННЫЙ PROXY-КАНАЛ АКТИВЕН';
        $('#status-title').textContent = 'Xray Core запущен';
        $('#status-description').textContent = model.xray.systemProxy ? `Системный Proxy Windows направлен на 127.0.0.1:${model.xray.httpPort}.` : `SOCKS 127.0.0.1:${model.xray.socksPort} · HTTP 127.0.0.1:${model.xray.httpPort}`;
      } else if (busy) {
        $('#status-kicker').textContent = 'ПЕРЕКЛЮЧЕНИЕ XRAY CORE';
        $('#status-title').textContent = 'Применение конфигурации…';
        $('#status-description').textContent = 'Дождитесь безопасного изменения системного Proxy.';
      } else if (!nodes.length) {
        $('#status-kicker').textContent = 'ОЖИДАНИЕ КОНФИГУРАЦИИ';
        $('#status-title').textContent = 'Добавьте открытую подписку';
        $('#status-description').textContent = 'Зашифрованные Happ-ссылки отключены. Используйте обычный HTTPS URL или share-ссылку.';
      } else {
        $('#status-kicker').textContent = 'XRAY КОНФИГУРАЦИЯ ГОТОВА';
        $('#status-title').textContent = `${nodes.length} узлов готовы к подключению`;
        $('#status-description').textContent = 'Выберите узел и нажмите START.';
      }
    }
  }

  function statusForPing(result) {
    if (result.state === 'running') return { text: 'ПРОВЕРКА', className: 'status-wait', latency: '…' };
    if (result.ok) return { text: result.latency > 180 ? 'МЕДЛЕННЫЙ' : 'ДОСТУПЕН', className: result.latency > 180 ? 'degraded' : 'status-online', latency: `${result.latency} ms` };
    if (result.state === 'done') return { text: 'НЕДОСТУПЕН', className: 'status-failed', latency: 'TIMEOUT' };
    return { text: 'НЕ ПРОВЕРЕН', className: 'status-wait', latency: '—' };
  }

  function renderNodes() {
    const table = $('#node-table');
    $$('.data-row, .subscription-group-row', table).forEach(row => row.remove());
    const nodes = allNodes();
    $('#nodes-empty').style.display = nodes.length ? 'none' : '';
    $('#ping-all').disabled = !nodes.length;
    $('#node-footer-count').textContent = `${nodes.length} узлов · ${model.snapshot.subscriptions.length} подписок`;
    const query = ($('#node-search').value || '').trim().toLowerCase();

    for (const subscription of model.snapshot.subscriptions) {
      const visibleNodes = (subscription.servers || []).filter(node => {
        const ping = pingState(node.id);
        if (model.nodeFilter === 'online' && !ping.ok) return false;
        if (model.nodeFilter === 'failed' && !(ping.state === 'done' && !ping.ok)) return false;
        return !query || `${node.name} ${node.host} ${node.protocol} ${subscription.name} ${subscription.note || ''}`.toLowerCase().includes(query);
      });
      if (!visibleNodes.length) continue;
      const group = make('div', `subscription-group-row${subscription.id === model.selectedSubscriptionId ? ' active' : ''}`);
      const groupTitle = make('div'); groupTitle.append(make('strong', '', subscription.name), make('small', '', `${visibleNodes.length} узлов${subscription.hwidEnabled ? ' · HWID' : ''}`));
      const groupNote = make('p', '', subscription.note || 'Без личной заметки');
      group.append(groupTitle, groupNote); table.append(group);

      for (const node of visibleNodes) {
        const ping = pingState(node.id); const status = statusForPing(ping);
        const row = make('div', `table-row data-row${node.id === model.selectedNodeId ? ' selected' : ''}`); row.dataset.nodeId = node.id;
        const selector = make('span', 'node-selector', node.id === model.selectedNodeId ? '◆' : '◇');
        const nodeCell = make('span', 'node-name'); const flag = make('i', 'flag', node.protocol.slice(0, 2).toUpperCase());
        const nodeText = make('span'); nodeText.append(make('strong', '', node.name), make('small', '', `${node.host}:${node.port}`)); nodeCell.append(flag, nodeText);
        const protocol = make('span'); protocol.append(make('b', 'protocol', node.protocol.toUpperCase()), make('small', '', [node.transport, node.security].filter(Boolean).join(' · ') || 'STANDARD'));
        const latency = make('span', `latency ${ping.ok ? (ping.latency < 180 ? 'good' : 'medium') : ''}`, status.latency);
        const source = make('span'); source.append(make('b', 'protocol', subscription.name), make('small', '', subscription.note || node.sni || 'без заметки'));
        const statusCell = make('span', status.className, status.text);
        const pingButton = make('button', `ping-button${ping.state === 'running' ? ' running' : ''}`); pingButton.title = 'Проверить этот узел'; pingButton.append(makeSvg('i-activity')); pingButton.disabled = ping.state === 'running';
        pingButton.addEventListener('click', event => { event.stopPropagation(); pingNodes([node.id]); });
        row.addEventListener('click', () => {
          if (['running','starting'].includes(model.xray.state) || ['running','starting'].includes(model.singbox.state)) { toast('Сначала остановите соединение', 'Смена активного узла во время Xray/TUN отключена.', 'info'); return; }
          model.selectedSubscriptionId = subscription.id; model.selectedNodeId = node.id; renderOverview(); renderNodes();
        });
        row.append(selector, nodeCell, protocol, latency, source, statusCell, pingButton); table.append(row);
      }
    }
  }

  function renderSubscriptions() {
    const grid = $('#subscription-grid');
    $$('.subscription-card', grid).forEach(card => card.remove());
    const subs = model.snapshot.subscriptions;
    $('#subscription-heading').textContent = subs.length ? `${subs.length} ${subs.length === 1 ? 'источник' : 'источника'} · только ваши данные` : 'Подписок пока нет';
    $('#update-all').disabled = !subs.some(item => item.hasRemoteUrl);

    for (const subscription of subs) {
      const card = make('article', 'panel subscription-card');
      const head = make('div', 'sub-head');
      const icon = make('div', 'sub-icon', subscription.sourceType === 'url' ? 'U//' : subscription.sourceType === 'file' ? 'F//' : 'T//');
      const title = make('div'); title.append(make('span', 'tag', subscription.sourceType.toUpperCase()), make('h3', '', subscription.name));
      const actions = make('div', 'sub-actions');
      if (subscription.hasRemoteUrl) {
        const refresh = make('button', 'icon-btn mini refresh-sub'); refresh.title = 'Обновить'; refresh.append(makeSvg('i-refresh')); refresh.addEventListener('click', () => updateSubscription(subscription.id, refresh)); actions.append(refresh);
      }
      const remove = make('button', 'icon-btn mini delete-sub'); remove.title = 'Удалить'; remove.append(makeSvg('i-trash')); remove.addEventListener('click', () => removeSubscription(subscription)); actions.append(remove);
      head.append(icon, title, actions);
      const source = make('div', 'sub-source', subscription.sourceHost || (subscription.hasRemoteUrl ? 'remote source' : 'local content'));
      const note = subscription.note ? make('div', 'sub-note-display', subscription.note) : null;
      const stats = make('div', 'sub-stats');
      for (const [label, value] of [['УЗЛОВ', subscription.serverCount], ['ОБНОВЛЕНО', formatDate(subscription.lastUpdated)], ['ОШИБКИ', subscription.parseWarnings || 0]]) {
        const cell = make('div'); cell.append(make('small', '', label), make('strong', '', String(value))); stats.append(cell);
      }
      const footer = make('div', 'sub-footer');
      footer.append(make('span', subscription.updateError ? 'degraded' : 'online', subscription.updateError ? `● ${subscription.updateError}` : '● ЛОКАЛЬНО СОХРАНЕНО'));
      if (subscription.hasRemoteUrl) {
        const hwidLabel = make('label', 'hwid-sub-toggle');
        const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(subscription.hwidEnabled);
        checkbox.addEventListener('change', () => setSubscriptionHwid(subscription.id, checkbox.checked));
        hwidLabel.append(checkbox, make('span', '', 'HWID'), make('i'));
        footer.append(hwidLabel);
      }
      footer.append(make('span', 'stage-badge', subscription.hasRemoteUrl ? 'REMOTE' : 'LOCAL'));
      card.append(head, source); if (note) card.append(note); card.append(stats, footer);
      grid.insertBefore(card, $('#subscription-empty-card'));
    }
  }

  function renderSecurity() {
    const encrypted = Boolean(model.snapshot.security?.encrypted);
    const core = model.xray.core || { available: model.xray.available, version: '' };
    $('#xray-version').textContent = core.available ? (core.version || 'READY') : 'MISSING';
    $('#xray-led').className = model.xray.state === 'running' ? 'running' : core.available ? '' : 'unavailable';
    $('#settings-xray-status').textContent = core.available ? 'ACTIVE' : 'MISSING';
    $('#settings-xray-status').className = `status-chip ${core.available ? 'good-chip' : 'bad-chip'}`;
    $('#settings-xray-detail').textContent = core.available ? `Xray ${core.version || ''} · Proxy mode; insecure TLS → Sing-box TUN` : api.isDesktop ? 'Файл ядра не найден в resources/xray' : 'Ядро доступно только в Windows-сборке';
    const singCore = model.singbox.core || { available: model.singbox.available, version: '' };
    $('#settings-singbox-status').textContent = singCore.available ? (model.singbox.state === 'running' ? 'TUN ACTIVE' : 'READY') : 'MISSING';
    $('#settings-singbox-status').className = `status-chip ${singCore.available ? 'good-chip' : 'bad-chip'}`;
    $('#settings-singbox-detail').textContent = singCore.available ? `sing-box ${singCore.version || ''} · TUN + mixed proxy` : 'Файл resources/sing-box/sing-box.exe не найден';
    $('#settings-zapret-status').textContent = model.zapret.available ? (model.zapret.state === 'running' ? 'RUNNING' : 'READY') : 'MISSING';
    $('#settings-zapret-status').className = `status-chip ${model.zapret.available ? 'good-chip' : 'bad-chip'}`;
    $('#settings-zapret-detail').textContent = model.zapret.available ? `${model.zapret.version || 'Flowseal 1.10.1'} · winws.exe + WinDivert` : 'Комплект resources/zapret не найден';
    $('#settings-hwid').textContent = model.snapshot.deviceIdentity?.hwid || 'IDENTITY UNAVAILABLE';
    const protocolsReady = Boolean(model.protocols.redline);
    $('#settings-protocol-status').textContent = protocolsReady ? 'ACTIVE' : api.isDesktop ? 'ERROR' : 'PREVIEW';
    $('#settings-protocol-status').className = `status-chip ${protocolsReady ? 'good-chip' : 'bad-chip'}`;
    $('#settings-protocol-detail').textContent = protocolsReady ? 'redline:// зарегистрирован; happ:// и crypt-доступ отключены' : api.isDesktop ? 'Не удалось зарегистрировать redline://' : 'Регистрация URL-протокола доступна только в Windows';
    $('#storage-status').textContent = encrypted ? 'ENCRYPTED' : api.isDesktop ? 'FALLBACK' : 'PREVIEW';
    $('#metric-storage').textContent = encrypted ? 'ENCRYPTED' : 'LOCAL';
    $('#metric-storage-detail').textContent = encrypted ? 'Windows safeStorage / DPAPI' : api.isDesktop ? 'Системное шифрование недоступно' : 'Браузерный preview без DPAPI';
    $('#security-badge').textContent = encrypted ? 'ENCRYPTED' : 'LOCAL';
    $('#security-badge').className = `stage-badge${encrypted ? '' : ' bad-chip'}`;
    $('#settings-encryption-status').textContent = encrypted ? 'ACTIVE' : 'FALLBACK';
    $('#settings-encryption-status').className = `status-chip ${encrypted ? 'good-chip' : 'bad-chip'}`;
    $('#settings-encryption-detail').textContent = encrypted ? 'Файл подписок зашифрован системным хранилищем Windows' : api.isDesktop ? 'Данные закрыты правами локального пользователя, но DPAPI недоступен' : 'Preview использует localStorage; реальные секреты сюда добавлять не следует';
    $('#security-note-text').textContent = encrypted ? 'Ссылки и полные конфигурации зашифрованы через Electron safeStorage/Windows DPAPI.' : 'В preview не вставляйте реальные секреты. Нативная Windows-сборка использует safeStorage/DPAPI.';
  }

  async function pingNodes(ids) {
    if (!ids.length) return;
    for (const id of ids) model.pings.set(id, { state: 'running', ok: false, latency: null });
    renderOverview(); renderNodes();
    addLog('info', 'Ping', `Запущена реальная проверка ${ids.length} узлов`);
    try {
      const results = await api.nodes.ping(ids, 3500);
      for (const result of results) model.pings.set(result.serverId, { ...result, state: 'done' });
      const ok = results.filter(item => item.ok).length;
      addLog(ok ? 'info' : 'warn', 'Ping', `Завершено: доступны ${ok} из ${results.length}`);
      toast('Проверка завершена', `Доступны ${ok} из ${results.length} узлов.`, ok ? 'secure' : 'error');
    } catch (error) {
      for (const id of ids) model.pings.set(id, { state: 'done', ok: false, latency: null, error: error.message, checkedAt: new Date().toISOString() });
      addLog('error', 'Ping', error.message);
      toast('Ошибка ping', error.message, 'error');
    }
    renderOverview(); renderNodes();
  }

  function openConnectionTerminal(command, stage = 'INITIALIZING') {
    $('#connect-terminal-lines').replaceChildren();
    $('#terminal-command').textContent = command;
    $('#terminal-stage').textContent = stage;
    $('#terminal-progress-bar').style.width = '4%';
    $('#terminal-progress-text').textContent = '4% · BOOTSTRAP';
    $('#terminal-close').disabled = true;
    $('#auth-console').hidden = true;
    $('#auth-windows-logo').hidden = true;
    $('#terminal-ascii').hidden = false;
    $('#auth-error').textContent = '';
    $('#connect-terminal').classList.add('open');
    $('#connect-terminal').setAttribute('aria-hidden', 'false');
  }

  function terminalLine(level, message, progress) {
    const row = make('div', `terminal-log-line ${level === 'error' ? 'error' : level === 'success' ? 'success' : ''}`);
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    row.append(make('time', '', time), make('b', '', level.toUpperCase()), make('span', '', message));
    $('#connect-terminal-lines').append(row);
    row.scrollIntoView({ block: 'nearest' });
    if (Number.isFinite(progress)) {
      $('#terminal-progress-bar').style.width = `${Math.max(0, Math.min(100, progress))}%`;
      $('#terminal-progress-text').textContent = `${progress}% · ${message.toUpperCase().slice(0, 38)}`;
    }
  }

  function finishConnectionTerminal(success, message) {
    $('#terminal-stage').textContent = success ? 'LINK ESTABLISHED' : 'SEQUENCE FAILED';
    $('#terminal-stage-led').style.background = success ? 'var(--green)' : '#ff5969';
    $('#terminal-progress-bar').style.width = success ? '100%' : '72%';
    $('#terminal-progress-text').textContent = success ? '100% · CHANNEL ONLINE' : `ERROR · ${message}`;
    $('#terminal-close').disabled = false;
    if (success) setTimeout(() => { if ($('#connect-terminal').classList.contains('open')) closeConnectionTerminal(); }, 1400);
  }

  function closeConnectionTerminal() {
    if (model.powerAction) { model.powerCountdownCancelled = true; return; }
    $('#terminal-close').textContent = 'ЗАКРЫТЬ';
    $('#connect-terminal').classList.remove('open');
    $('#connect-terminal').setAttribute('aria-hidden', 'true');
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function unlockStartupIfRequired() {
    const status = await api.security.status();
    model.passwordRequired = Boolean(status.required);
    $('#password-status').textContent = status.required ? 'ENABLED' : 'DISABLED';
    $('#password-status').className = `status-chip ${status.required ? 'good-chip' : ''}`;
    if (!status.required || status.unlocked) return;
    openConnectionTerminal('auth --operator --local-only', 'ACCESS LOCKED');
    terminalLine('auth', 'Startup password required', 20);
    terminalLine('vault', 'Password verifier: scrypt · local storage', 38);
    $('#auth-windows-logo').hidden = false;
    $('#terminal-ascii').hidden = true;
    $('#auth-console').hidden = false;
    $('#terminal-command').textContent = 'awaiting password input';
    $('#startup-password-input').value = '';
    setTimeout(() => $('#startup-password-input').focus(), 80);
    await new Promise(resolve => { model.authResolve = resolve; });
  }

  async function runShutdownSequence() {
    if (runShutdownSequence.active) return;
    runShutdownSequence.active = true;
    openConnectionTerminal('shutdown --preserve-network-state --zero-ui', 'SHUTDOWN SEQUENCE');
    const steps = [
      ['save', 'Persisting theme and interface profile', 18],
      ['vault', 'Sealing local configuration vault', 36],
      ['route', model.zapret.state === 'running' ? 'DPI Shield remains active by operator policy' : 'No active DPI process', 48],
      ['tun', model.singbox.state === 'running' ? 'Scheduling TUN route restoration' : 'TUN already offline', 64],
      ['core', model.xray.state === 'running' ? 'Scheduling safe Xray shutdown' : 'Xray already offline', 78],
      ['success', 'GOODBYE, OPERATOR // STAY UNSEEN', 100]
    ];
    for (const [level, text, progress] of steps) { terminalLine(level, text, progress); await wait(170); }
    $('#terminal-stage').textContent = 'SESSION CLOSED';
    await wait(450);
    api.appLifecycle.confirmClose();
  }

  async function runZapretTest({ automatic = false } = {}) {
    if (model.zapret.state !== 'running') { if (!automatic) toast('DPI Shield не запущен', 'Сначала подключите выбранную стратегию.', 'error'); return null; }
    if (!automatic) {
      openConnectionTerminal('diagnose --targets=youtube,discord --tls --dns', 'DIAGNOSTICS');
      terminalLine('test', 'Launching external reachability matrix', 12);
    }
    try {
      const report = await api.zapret.test();
      terminalLine(report.ok ? 'success' : 'warn', `Diagnostic score: ${report.passed}/${report.total}`, 100);
      if (!automatic) finishConnectionTerminal(true, `TEST ${report.passed}/${report.total}`);
      toast('DPI диагностика', `${report.passed}/${report.total} сервисов доступны.`, report.ok ? 'secure' : 'info');
      return report;
    } catch (error) {
      terminalLine('error', error.message, 70);
      if (!automatic) finishConnectionTerminal(false, error.message);
      toast('Ошибка диагностики', error.message, 'error');
      return null;
    }
  }

  async function toggleZapret() {
    if (!api.isDesktop) { toast('Только Windows-сборка', 'DPI Shield требует WinDivert и права администратора.', 'error'); return; }
    const running = model.zapret.state === 'running';
    openConnectionTerminal(running ? 'shutdown --dpi-shield --unload-driver' : `deploy --dpi-shield --profile=${$('#zapret-profile').value}`, running ? 'DISCONNECTING' : 'INITIALIZING');
    terminalLine('sys', 'REDLINE DPI CONTROL MATRIX', 8);
    try {
      if (running) {
        model.zapret.state = 'stopping'; renderOverview();
        terminalLine('kill', 'Requesting elevated winws termination', 25);
        const status = await api.zapret.stop();
        model.zapret = { ...model.zapret, ...status };
        terminalLine('ok', 'WinDivert filters unloaded', 82);
        terminalLine('success', 'DPI bypass disconnected', 100);
        finishConnectionTerminal(true, 'DISCONNECTED');
        toast('DPI Shield отключён', 'winws и WinDivert остановлены.', 'secure');
      } else {
        model.zapret.state = 'starting'; renderOverview();
        terminalLine('scan', 'Scanning Windows network stack', 15);
        terminalLine('auth', 'Awaiting UAC administrator approval', 24);
        const status = await api.zapret.start($('#zapret-profile').value);
        model.zapret = { ...model.zapret, ...status };
        terminalLine('ok', `Strategy ${status.profileName || 'GENERAL'} online`, 72);
        terminalLine('test', 'Running YouTube + Discord verification', 82);
        const report = await runZapretTest({ automatic: true });
        terminalLine('success', report ? `Bypass online · test ${report.passed}/${report.total}` : 'Bypass online · diagnostic unavailable', 100);
        finishConnectionTerminal(true, 'CONNECTED');
        toast('DPI Shield подключён', report ? `YouTube/Discord test: ${report.passed}/${report.total}.` : 'Локальный DPI bypass активен.', 'secure');
      }
    } catch (error) {
      model.zapret.state = 'error';
      terminalLine('error', error.message, 72);
      finishConnectionTerminal(false, error.message);
      toast('DPI Shield: ошибка', error.message, 'error');
    }
    renderEverything();
  }

  function handleZapretEvent(event) {
    if (!event) return;
    if (event.status) model.zapret = { ...model.zapret, ...event.status };
    if (event.message) {
      addLog(event.level || 'info', 'DPI Shield', event.message);
      if ($('#connect-terminal').classList.contains('open')) {
        const progress = /UAC/i.test(event.message) ? 32 : /WinDivert/i.test(event.message) ? 58 : /Discord/i.test(event.message) ? 78 : /YouTube/i.test(event.message) ? 88 : undefined;
        terminalLine(event.level === 'error' ? 'error' : event.type === 'state' ? 'state' : 'exec', event.message, progress);
      }
    }
    renderOverview(); renderSecurity();
  }

  async function toggleSingbox() {
    if (!api.isDesktop) { toast('Только Windows-сборка', 'Sing-box TUN требует права администратора.', 'error'); return; }
    const running = model.singbox.state === 'running';
    if (running) {
      openConnectionTerminal('shutdown --sing-box --restore-routes', 'DISCONNECTING TUN');
      terminalLine('route', 'Removing REDLINE-TUN routes and DNS interception', 24);
      model.singbox.state = 'stopping'; renderOverview();
      try {
        const status = await api.singbox.stop(); model.singbox = { ...model.singbox, ...status };
        terminalLine('success', 'TUN adapter closed · routes restored', 100); finishConnectionTerminal(true, 'TUN OFFLINE');
        toast('Sing-box TUN остановлен', 'Системные маршруты восстановлены.', 'secure');
      } catch (error) { model.singbox.state = 'error'; terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message); toast('Ошибка TUN', error.message, 'error'); }
      renderEverything(); return;
    }
    const node = selectedNode();
    if (!node) { toast('Нет выбранного узла', 'Добавьте подписку и выберите сервер.', 'error'); return; }
    if (!model.singbox.available) { toast('Sing-box отсутствует', 'Используйте полную сборку с resources/sing-box.', 'error'); return; }
    openConnectionTerminal(`deploy --sing-box --tun=REDLINE-TUN --node=${node.name}`, 'TUN BOOT SEQUENCE');
    terminalLine('scan', 'Validating Sing-box outbound', 15);
    terminalLine('route', 'Preparing auto_route + strict_route', 28);
    terminalLine('dns', 'Arming DNS and QUIC interception', 42);
    model.singbox = { ...model.singbox, state: 'starting', serverId: node.id, serverName: node.name }; renderOverview();
    try {
      const status = await api.singbox.start({ serverId: node.id, mixedPort: 10818, mtu: 9000, stack: 'mixed' });
      model.singbox = { ...model.singbox, ...status };
      terminalLine('tun', `${status.interfaceName} ONLINE`, 78);
      terminalLine('success', `TCP/UDP/QUIC/DNS · MIXED 127.0.0.1:${status.mixedPort}`, 100); finishConnectionTerminal(true, 'FULL TUN CONNECTED');
      toast('Sing-box TUN подключён', 'Весь трафик компьютера направлен через туннель.', 'secure');
    } catch (error) { model.singbox.state = 'error'; terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message); toast('Sing-box TUN: ошибка', error.message, 'error'); }
    renderEverything();
  }

  function handleSingboxEvent(event) {
    if (!event) return;
    if (event.status) model.singbox = { ...model.singbox, ...event.status };
    if (event.message) {
      addLog(event.level || 'info', 'Sing-box TUN', event.message);
      if ($('#connect-terminal').classList.contains('open')) terminalLine(event.level === 'error' ? 'error' : event.type === 'state' ? 'state' : 'core', event.message);
    }
    renderOverview(); renderSecurity();
  }

  function toggleActiveEngine() {
    return model.activeEngine === 'zapret' ? toggleZapret() : model.activeEngine === 'singbox' ? toggleSingbox() : toggleXray();
  }

  async function toggleXray() {
    if (!api.isDesktop) {
      toast('Только Windows-сборка', 'Xray Core нельзя запустить внутри браузерного preview.', 'info');
      return;
    }
    const running = model.xray.state === 'running';
    if (running) {
      openConnectionTerminal('shutdown --xray --restore-system-proxy', 'DISCONNECTING');
      terminalLine('kill', 'Stopping Xray core and restoring Windows proxy', 24);
      model.xray.state = 'stopping'; renderOverview();
      addLog('info', 'Xray', 'Остановка ядра и восстановление системного Proxy');
      try {
        const status = await api.xray.stop();
        model.xray = { ...model.xray, ...status };
        terminalLine('success', 'System proxy restored · Xray offline', 100); finishConnectionTerminal(true, 'DISCONNECTED');
        toast('Xray остановлен', 'Предыдущие настройки системного Proxy восстановлены.', 'secure');
      } catch (error) {
        model.xray.state = 'error'; terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message); toast('Ошибка остановки', error.message, 'error'); addLog('error', 'Xray', error.message);
      }
      renderEverything();
      return;
    }

    const node = selectedNode();
    if (!node) { toast('Нет выбранного узла', 'Сначала добавьте подписку и выберите сервер.', 'error'); return; }
    if (!model.xray.available) { toast('Xray Core не найден', 'Используйте полную Windows-сборку с папкой resources/xray.', 'error'); return; }
    openConnectionTerminal(`deploy --xray --node=${node.name}`, 'INITIALIZING');
    terminalLine('scan', 'Validating encrypted transport configuration', 18);
    terminalLine('route', `Target node: ${node.name}`, 29);
    model.xray = { ...model.xray, state: 'starting', serverId: node.id, serverName: node.name };
    renderOverview();
    addLog('info', 'Xray', `Запуск через пользовательский узел ${node.name}`);
    try {
      const status = await api.xray.start({ serverId: node.id, systemProxy: $('#system-proxy-toggle').checked, loglevel: 'warning' });
      model.xray = { ...model.xray, ...status };
      terminalLine('success', `${status.coreMode === 'compat-insecure' ? 'COMPAT TLS CORE 26.1.23' : 'MODERN CORE 26.7.28'} · SOCKS ${status.socksPort} · HTTP ${status.httpPort}`, 100); finishConnectionTerminal(true, 'CONNECTED');
      toast('Xray подключён', status.systemProxy ? 'Системный Proxy Windows активирован.' : `Локальный SOCKS: 127.0.0.1:${status.socksPort}`, 'secure');
      addLog('info', 'Xray', `Локальные порты: SOCKS ${status.socksPort}, HTTP ${status.httpPort}`);
    } catch (error) {
      model.xray.state = 'error';
      terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message);
      toast('Xray не запущен', error.message, 'error');
      addLog('error', 'Xray', error.message);
    }
    renderEverything();
  }

  function handleXrayEvent(event) {
    if (!event) return;
    if (event.status) model.xray = { ...model.xray, ...event.status };
    if (event.type === 'log' && event.message) addLog(event.level || 'info', 'Xray Core', event.message);
    if (event.type === 'state' && event.message) addLog(event.status?.state === 'error' ? 'error' : 'info', 'Xray', event.message);
    if (event.message && $('#connect-terminal').classList.contains('open')) terminalLine(event.level === 'error' ? 'error' : 'core', event.message);
    renderOverview(); renderSecurity();
  }

  async function setSubscriptionHwid(id, enabled) {
    try {
      const result = await api.subscriptions.setHwid(id, enabled);
      applySnapshot(result.snapshot);
      if (enabled) {
        toast('HWID подписки', 'Device headers включены. Обновляю источник…', 'secure');
        const refreshed = await api.subscriptions.update(id);
        applySnapshot(refreshed.snapshot);
        if (refreshed.subscription.servers?.length) pingNodes(refreshed.subscription.servers.map(server => server.id));
      } else toast('HWID подписки', 'HWID для подписки отключён.', 'secure');
      addLog('info', 'Subscription', `HWID ${enabled ? 'enabled' : 'disabled'} for ${result.subscription.name}`);
    } catch (error) { toast('HWID', error.message, 'error'); renderSubscriptions(); }
  }

  async function updateSubscription(id, button) {
    button.disabled = true; button.classList.add('spinning');
    addLog('info', 'Subscription', 'Запрошено обновление пользовательского источника');
    try {
      const result = await api.subscriptions.update(id); applySnapshot(result.snapshot);
      toast('Подписка обновлена', `Получено узлов: ${result.subscription.serverCount}.`, 'secure');
      addLog('info', 'Subscription', `${result.subscription.name}: ${result.subscription.serverCount} узлов`);
    } catch (error) { toast('Ошибка обновления', error.message, 'error'); addLog('error', 'Subscription', error.message); }
    finally { button.disabled = false; button.classList.remove('spinning'); }
  }

  async function removeSubscription(subscription) {
    if ((model.xray.state === 'running' && subscription.servers.some(server => server.id === model.xray.serverId)) || (model.singbox.state === 'running' && subscription.servers.some(server => server.id === model.singbox.serverId))) {
      toast('Источник используется', 'Сначала остановите Xray/TUN, затем удалите подписку.', 'error');
      return;
    }
    if (!confirm(`Удалить подписку «${subscription.name}» и все её узлы?`)) return;
    try { const result = await api.subscriptions.remove(subscription.id); model.pings.clear(); applySnapshot(result.snapshot); toast('Источник удалён', subscription.name); addLog('warn', 'Subscription', `Удалён источник ${subscription.name}`); }
    catch (error) { toast('Не удалось удалить', error.message, 'error'); }
  }

  function setView(id) {
    const button = $(`.nav-item[data-view="${id}"]`); if (!button) return;
    $$('.nav-item').forEach(item => item.classList.toggle('active', item === button));
    $$('.view').forEach(view => view.classList.toggle('active', view.id === id));
    $('#page-title').textContent = button.dataset.title; $('#page-subtitle').textContent = button.dataset.subtitle; $('#crumb').textContent = id.toUpperCase();
    $('.content').scrollTo({ top: 0, behavior: 'smooth' });
  }

  $$('.nav-item[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('.node-shortcut').forEach(button => button.addEventListener('click', () => setView('nodes')));
  $$('.log-shortcut').forEach(button => button.addEventListener('click', () => setView('logs')));

  const deepLinkModal = $('#deeplink-modal');

  function showNextDeepLink() {
    if (model.deepLink || !model.deepLinkQueue.length) return;
    model.deepLink = model.deepLinkQueue.shift();
    $('#deeplink-display').textContent = model.deepLink.display;
    $('#deeplink-name').value = model.deepLink.name || '';
    $('#deeplink-description').textContent = model.deepLink.kind === 'url'
      ? `После подтверждения приложение загрузит открытую подписку с узла ${model.deepLink.sourceHost}.`
      : `Будет добавлена открытая конфигурация из внешней ссылки${model.deepLink.serverCount ? ` · узлов: ${model.deepLink.serverCount}` : ''}.`;
    deepLinkModal.classList.add('open');
    deepLinkModal.setAttribute('aria-hidden', 'false');
    if (document.hasFocus()) setTimeout(() => $('#deeplink-name').focus(), 50);
  }

  async function rejectDeepLink() {
    const current = model.deepLink;
    model.deepLink = null;
    deepLinkModal.classList.remove('open');
    deepLinkModal.setAttribute('aria-hidden', 'true');
    if (current) {
      try { await api.deepLinks.reject(current.token); } catch (_) { /* Request expires automatically. */ }
      addLog('warn', 'DeepLink', 'Пользователь отклонил внешний запрос импорта');
    }
    showNextDeepLink();
  }

  async function acceptDeepLink() {
    const current = model.deepLink;
    if (!current) return;
    const button = $('#deeplink-accept');
    button.disabled = true;
    button.textContent = current.kind === 'url' ? 'ЗАГРУЗКА…' : 'ИМПОРТ…';
    try {
      const result = await api.deepLinks.accept(current.token, $('#deeplink-name').value.trim());
      model.deepLink = null;
      deepLinkModal.classList.remove('open');
      deepLinkModal.setAttribute('aria-hidden', 'true');
      applySnapshot(result.snapshot);
      setView('subscriptions');
      toast('Подписка добавлена с сайта', `${result.subscription.name}: ${result.subscription.serverCount} узлов.`, 'secure');
      addLog('info', 'DeepLink', `Подтверждён импорт ${result.subscription.name}: ${result.subscription.serverCount} узлов`);
      if (result.subscription.servers?.length) pingNodes(result.subscription.servers.map(server => server.id));
      showNextDeepLink();
    } catch (error) {
      model.deepLink = null;
      deepLinkModal.classList.remove('open');
      toast('Deep link не импортирован', error.message, 'error');
      addLog('error', 'DeepLink', error.message);
      showNextDeepLink();
    } finally {
      button.disabled = false;
      button.replaceChildren(makeSvg('i-download'), document.createTextNode(' Добавить'));
    }
  }

  api.deepLinks.onRequest(candidate => { model.deepLinkQueue.push(candidate); showNextDeepLink(); });
  api.deepLinks.onError(message => { toast('Внешняя ссылка отклонена', String(message), 'error'); addLog('error', 'DeepLink', String(message)); });
  $$('.deeplink-reject').forEach(button => button.addEventListener('click', rejectDeepLink));
  $('#deeplink-accept').addEventListener('click', acceptDeepLink);

  const modal = $('#subscription-modal');
  function openModal() { modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); setTimeout(() => $('#sub-name').focus(), 50); }
  function closeModal() { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
  $$('.add-subscription').forEach(button => button.addEventListener('click', openModal));
  $$('.modal-close').forEach(button => button.addEventListener('click', closeModal));
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });

  $$('.import-types button').forEach(button => button.addEventListener('click', () => {
    model.importType = button.dataset.importType;
    $$('.import-types button').forEach(item => item.classList.toggle('active', item === button));
    $$('.import-pane').forEach(pane => pane.classList.toggle('active', pane.dataset.importPane === model.importType));
    $('#import-subscription').style.display = model.importType === 'file' ? 'none' : '';
  }));

  async function importSubscription() {
    const button = $('#import-subscription'); button.disabled = true; button.textContent = 'ИМПОРТ…';
    try {
      const name = $('#sub-name').value.trim();
      const result = model.importType === 'url'
        ? await api.subscriptions.addUrl({ name, note: $('#sub-note').value, url: $('#sub-url').value.trim(), autoUpdate: $('#sub-auto-update').checked, hwidEnabled: $('#sub-hwid-enabled').checked })
        : await api.subscriptions.addContent({ name, note: $('#sub-note').value, content: $('#sub-content').value, sourceType: 'text' });
      applySnapshot(result.snapshot); closeModal(); setView('subscriptions');
      toast('Подписка добавлена', `${result.subscription.serverCount} узлов сохранено локально.`, 'secure');
      addLog('info', 'Subscription', `Добавлен источник ${result.subscription.name}: ${result.subscription.serverCount} узлов`);
      if (result.subscription.servers?.length) pingNodes(result.subscription.servers.map(server => server.id));
      $('#sub-name').value = ''; $('#sub-note').value = ''; $('#sub-url').value = ''; $('#sub-content').value = ''; $('#sub-hwid-enabled').checked = false;
    } catch (error) { toast('Импорт не выполнен', error.message, 'error'); addLog('error', 'Import', error.message); }
    finally { button.disabled = false; button.replaceChildren(makeSvg('i-download'), document.createTextNode(' Импортировать')); }
  }
  $('#import-subscription').addEventListener('click', importSubscription);
  $('#choose-file').addEventListener('click', async () => {
    try {
      const result = await api.subscriptions.importFile({ note: $('#sub-note').value }); if (result.canceled) return;
      applySnapshot(result.snapshot); closeModal(); setView('subscriptions');
      toast('Файл импортирован', `${result.subscription.serverCount} узлов сохранено.`, 'secure');
      addLog('info', 'Import', `Локальный файл: ${result.subscription.serverCount} узлов`);
      $('#sub-note').value = '';
      if (result.subscription.servers?.length) pingNodes(result.subscription.servers.map(server => server.id));
    } catch (error) { toast('Ошибка файла', error.message, 'error'); addLog('error', 'Import', error.message); }
  });

  $('#ping-all').addEventListener('click', () => pingNodes(allNodes().map(node => node.id)));
  $('#ping-selected').addEventListener('click', () => { const node = selectedNode(); if (node) pingNodes([node.id]); });
  $('#power-button').addEventListener('click', toggleActiveEngine);
  $('#active-subscription-select').addEventListener('change', event => { model.selectedSubscriptionId = event.target.value; const nodes = nodesForSelectedSubscription(); model.selectedNodeId = nodes[0]?.id || ''; renderOverview(); renderNodes(); });
  $('#active-node-select').addEventListener('change', event => { model.selectedNodeId = event.target.value; renderOverview(); renderNodes(); });
  $('#terminal-close').addEventListener('click', closeConnectionTerminal);
  $('#zapret-test').addEventListener('click', () => runZapretTest());
  $('#zapret-profile').addEventListener('change', event => localStorage.setItem('redline-zapret-profile', event.target.value));
  $$('#engine-selector button').forEach(button => button.addEventListener('click', () => {
    if (['running', 'starting', 'stopping'].includes(model.xray.state) || ['running', 'starting', 'stopping'].includes(model.singbox.state) || ['running', 'starting', 'stopping'].includes(model.zapret.state)) {
      toast('Сначала отключитесь', 'Нельзя сменить сетевой движок во время активного соединения.', 'error'); return;
    }
    model.activeEngine = button.dataset.engine;
    localStorage.setItem('redline-engine', model.activeEngine);
    renderOverview();
  }));
  $('#node-search').addEventListener('input', renderNodes);
  $$('[data-node-filter]').forEach(button => button.addEventListener('click', () => { model.nodeFilter = button.dataset.nodeFilter; $$('[data-node-filter]').forEach(item => item.classList.toggle('active', item === button)); renderNodes(); }));

  $('#update-all').addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.classList.add('spinning');
    try { const result = await api.subscriptions.updateAll(); applySnapshot(result.snapshot); const ok = result.results.filter(item => item.ok).length; toast('Обновление завершено', `Успешно: ${ok} из ${result.results.length}.`, ok ? 'secure' : 'error'); addLog('info', 'Subscription', `Обновлены ${ok} из ${result.results.length} источников`); }
    catch (error) { toast('Ошибка обновления', error.message, 'error'); addLog('error', 'Subscription', error.message); }
    finally { button.disabled = false; button.classList.remove('spinning'); }
  });

  $$('.power-action').forEach(button => button.addEventListener('click', () => runPowerCountdown(button.dataset.power)));
  $('#agreement-checkbox').addEventListener('change', event => { $('#agreement-accept').disabled = !event.target.checked; });
  $('#agreement-accept').addEventListener('click', async () => { await api.security.acceptAgreement(); beginOnboarding(); });
  $('#agreement-exit').addEventListener('click', () => api.appLifecycle.confirmClose());
  $('#onboarding-back').addEventListener('click', () => { if (model.onboardingIndex > 0) { model.onboardingIndex -= 1; renderOnboardingStep(); } });
  $('#onboarding-next').addEventListener('click', async () => { if (model.onboardingIndex < onboardingSteps.length - 1) { model.onboardingIndex += 1; renderOnboardingStep(); } else await finishFirstRun(); });
  $('#onboarding-skip').addEventListener('click', finishFirstRun);
  $('#restart-onboarding').addEventListener('click', async () => { const status = await api.security.resetOnboarding(); await runFirstRunIfNeeded({ ...status, agreementAccepted: true, system: model.osInfo }); });

  $('#auth-console').addEventListener('submit', async event => {
    event.preventDefault();
    const input = $('#startup-password-input');
    const button = $('#auth-console button');
    button.disabled = true; $('#auth-error').textContent = '';
    try {
      await api.security.verify(input.value);
      input.value = '';
      $('#auth-console').hidden = true;
      $('#terminal-stage').textContent = 'AUTHENTICATING';
      terminalLine('auth', 'Password signature accepted', 48);
      await wait(420);
      terminalLine('hwid', 'Собираем отпечаток HWID…', 57);
      await wait(620);
      terminalLine('hash', 'Проверяем аппаратный SHA-256 идентификатор', 66);
      await wait(650);
      terminalLine('vault', 'Монтируем локальное DPAPI-хранилище', 75);
      await wait(650);
      terminalLine('system', 'Проверяем Windows 11 x64 security context', 84);
      await wait(650);
      terminalLine('route', 'Инициализируем TUN / Xray / DPI control plane', 93);
      await wait(620);
      terminalLine('success', 'ACCESS GRANTED // WELCOME, OPERATOR', 100);
      $('#terminal-stage').textContent = 'OPERATOR VERIFIED';
      $('#terminal-command').textContent = 'session --unlock --local-only';
      await wait(350); closeConnectionTerminal();
      model.authResolve?.(); model.authResolve = null;
    } catch (error) {
      $('#auth-error').textContent = error.message;
      terminalLine('deny', error.message, 45);
      input.value = ''; input.focus();
    } finally { button.disabled = false; }
  });
  $('#save-startup-password').addEventListener('click', async () => {
    const password = $('#new-startup-password').value;
    const confirm = $('#confirm-startup-password').value;
    if (password !== confirm) { toast('Пароль', 'Пароли не совпадают.', 'error'); return; }
    try {
      const status = await api.security.setPassword(password);
      model.passwordRequired = status.required;
      $('#password-status').textContent = 'ENABLED'; $('#password-status').className = 'status-chip good-chip';
      $('#new-startup-password').value = ''; $('#confirm-startup-password').value = '';
      toast('Пароль установлен', 'При следующем запуске появится консоль авторизации.', 'secure');
    } catch (error) { toast('Пароль', error.message, 'error'); }
  });
  $('#remove-startup-password').addEventListener('click', async () => {
    try { await api.security.removePassword(); model.passwordRequired = false; $('#password-status').textContent = 'DISABLED'; $('#password-status').className = 'status-chip'; toast('Пароль удалён', 'REDLINE будет открываться без консоли авторизации.', 'secure'); }
    catch (error) { toast('Пароль', error.message, 'error'); }
  });

  $('#emergency-reset').addEventListener('click', async () => {
    if (!confirm('Аварийный сброс остановит все сетевые движки и локальные процессы xray/sing-box/winws. Подписки и заметки сохранятся. Продолжить?')) return;
    openConnectionTerminal('emergency-reset --network --preserve-subscriptions', 'EMERGENCY RESET');
    terminalLine('kill', 'Останавливаем Xray / Sing-box / DPI Shield', 18);
    terminalLine('route', 'Готовим восстановление Proxy и маршрутов', 32);
    try {
      const result = await api.system.emergencyReset();
      let progress = 42;
      for (const line of result.report || []) { terminalLine('reset', line, Math.min(95, progress)); progress += 9; }
      const [xrayStatus, singboxStatus, zapretStatus] = await Promise.all([api.xray.status(), api.singbox.status(), api.zapret.status()]);
      model.xray = { ...model.xray, ...xrayStatus }; model.singbox = { ...model.singbox, ...singboxStatus }; model.zapret = { ...model.zapret, ...zapretStatus };
      $('#emergency-report').textContent = (result.report || []).join('\n');
      terminalLine('success', 'NETWORK STATE RESET COMPLETE', 100); finishConnectionTerminal(true, 'RESET COMPLETE');
      toast('Аварийный сброс завершён', 'Сетевые движки остановлены, DNS-кеш очищен.', 'secure'); renderEverything();
    } catch (error) { terminalLine('error', error.message, 70); finishConnectionTerminal(false, error.message); toast('Аварийный сброс', error.message, 'error'); }
  });

  $('#autostart-toggle').addEventListener('change', async event => {
    event.target.disabled = true;
    try { const status = await api.system.setAutostart(event.target.checked); event.target.checked = status.enabled; toast('Автозапуск', status.enabled ? 'REDLINE запустится при входе в Windows.' : 'Автозапуск отключён.', 'secure'); }
    catch (error) { event.target.checked = !event.target.checked; toast('Автозапуск', error.message, 'error'); }
    finally { event.target.disabled = false; }
  });
  $('#exit-fullscreen').addEventListener('click', async () => { await api.window.exitFullscreen(); toast('Режим окна', 'Полноэкранный режим отключён. Вернуться можно перезапуском REDLINE.', 'info'); });
  $('#exit-redline').addEventListener('click', () => api.window.close());

  $('#clear-logs').addEventListener('click', () => { model.logs = []; renderLogs(); });
  $('#log-search').addEventListener('input', renderLogs);
  $$('.log-levels button').forEach(button => button.addEventListener('click', () => { $$('.log-levels button').forEach(item => item.classList.toggle('active', item === button)); renderLogs(); }));
  $('#scanline-toggle').addEventListener('change', event => document.body.classList.toggle('no-scanline', !event.target.checked));

  function applyAppearance() {
    document.body.dataset.theme = model.theme;
    document.body.classList.toggle('simple-mode', model.uiMode === 'simple');
    $$('.theme-choice').forEach(button => button.classList.toggle('active', button.dataset.theme === model.theme));
    $$('[data-ui-mode]').forEach(button => button.classList.toggle('active', button.dataset.uiMode === model.uiMode));
    $('#ui-mode-switch').classList.toggle('simple', model.uiMode === 'simple');
    $('#ui-mode-switch span').textContent = model.uiMode === 'simple' ? 'УПР. MODE' : 'PRO MODE';
  }
  $$('.theme-choice').forEach(button => button.addEventListener('click', () => { model.theme = button.dataset.theme; localStorage.setItem('redline-theme', model.theme); applyAppearance(); }));
  $$('[data-ui-mode]').forEach(button => button.addEventListener('click', () => { model.uiMode = button.dataset.uiMode; localStorage.setItem('redline-ui-mode', model.uiMode); applyAppearance(); setView('dashboard'); }));
  $('#ui-mode-switch').addEventListener('click', () => { model.uiMode = model.uiMode === 'pro' ? 'simple' : 'pro'; localStorage.setItem('redline-ui-mode', model.uiMode); applyAppearance(); setView('dashboard'); });
  applyAppearance();
  document.body.classList.toggle('no-scanline', !$('#scanline-toggle').checked);
  const rainGlyphs = '01アイウエオカキクケコサシスセソREDLINE';
  for (let column = 0; column < 30; column += 1) {
    const stream = make('span');
    stream.style.left = `${(column / 29) * 100}%`;
    stream.style.animationDelay = `${-(Math.random() * 8).toFixed(2)}s`;
    stream.style.animationDuration = `${(5 + Math.random() * 7).toFixed(2)}s`;
    stream.textContent = Array.from({ length: 18 }, () => rainGlyphs[Math.floor(Math.random() * rainGlyphs.length)]).join('\n');
    $('#terminal-rain').append(stream);
  }

  // Native window controls and zoom.
  $('#win-minimize').addEventListener('click', () => api.window.minimize());
  $('#win-maximize').addEventListener('click', () => api.window.maximize());
  $('#win-close').addEventListener('click', () => api.window.close());
  async function zoom(action) { const value = await api.window.zoom(action); $('#zoom-reset').textContent = `${value}%`; }
  $('#zoom-in').addEventListener('click', () => zoom('in')); $('#zoom-out').addEventListener('click', () => zoom('out')); $('#zoom-reset').addEventListener('click', () => zoom('reset'));

  // Command palette.
  const palette = $('#command-palette');
  const openPalette = () => { palette.classList.add('open'); palette.setAttribute('aria-hidden', 'false'); $('#command-input').value = ''; setTimeout(() => $('#command-input').focus(), 20); };
  const closePalette = () => { palette.classList.remove('open'); palette.setAttribute('aria-hidden', 'true'); };
  $('#command-open').addEventListener('click', openPalette); palette.addEventListener('click', event => { if (event.target === palette) closePalette(); });
  $('#command-input').addEventListener('input', event => { const query = event.target.value.toLowerCase(); $$('.command-results button').forEach(button => button.style.display = button.textContent.toLowerCase().includes(query) ? '' : 'none'); });
  $$('.command-results button').forEach(button => button.addEventListener('click', () => { closePalette(); const command = button.dataset.command; if (command === 'connect') toggleActiveEngine(); if (command === 'add') openModal(); if (command === 'nodes' || command === 'logs') setView(command); if (command === 'ping') pingNodes(allNodes().map(node => node.id)); }));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
    if (event.key === 'Escape') { closePalette(); closeModal(); if (model.deepLink) rejectDeepLink(); }
  });

  api.xray.onEvent(handleXrayEvent);
  api.singbox.onEvent(handleSingboxEvent);
  api.zapret.onEvent(handleZapretEvent);
  api.appLifecycle.onShutdownRequest(runShutdownSequence);

  async function initialize() {
    try {
      const firstRunStatus = await api.security.status();
      await runFirstRunIfNeeded(firstRunStatus);
      await unlockStartupIfRequired();
      const [info, snapshot, xrayStatus, singboxStatus, zapretStatus] = await Promise.all([api.appInfo(), api.subscriptions.list(), api.xray.status(), api.singbox.status(), api.zapret.status()]);
      $('#title-version').textContent = `NATIVE · ${info.version}`; $('#settings-version').textContent = info.version;
      model.xray = { ...xrayStatus, core: xrayStatus.core || info.xray || { available: false, version: '' } };
      model.singbox = { ...singboxStatus, core: singboxStatus.core || info.singbox || { available: false, version: '' } };
      model.zapret = { ...zapretStatus };
      if (model.zapret.state === 'running') model.activeEngine = 'zapret';
      else if (model.singbox.state === 'running') model.activeEngine = 'singbox';
      else if (model.xray.state === 'running') model.activeEngine = 'xray';
      model.protocols = info.protocols || { redline: false, happ: false };
      if (Array.isArray(zapretStatus.profiles) && zapretStatus.profiles.length) {
        const select = $('#zapret-profile'); select.replaceChildren();
        for (const profile of zapretStatus.profiles.filter(item => item.available)) { const option = make('option', '', `${profile.name} — ${profile.description}`); option.value = profile.id; select.append(option); }
        select.value = zapretStatus.profileId || localStorage.getItem('redline-zapret-profile') || 'general';
      }
      applySnapshot(snapshot);
      addLog('info', 'System', `${api.isDesktop ? 'Нативное приложение' : 'Browser preview'} запущено; встроенных серверов: 0`);
      addLog(model.xray.core?.available ? 'info' : 'warn', 'Xray', model.xray.core?.available ? `Core ${model.xray.core.version} готов` : 'Сетевое ядро недоступно в этой среде');
      addLog(model.singbox.core?.available ? 'info' : 'warn', 'Sing-box TUN', model.singbox.core?.available ? `Core ${model.singbox.core.version} готов` : 'TUN core недоступен');
      addLog(model.zapret.available ? 'info' : 'warn', 'DPI Shield', model.zapret.available ? `${model.zapret.version} готов · ${model.zapret.state}` : 'Flowseal Zapret недоступен');
      addLog(snapshot.security?.encrypted ? 'info' : 'warn', 'Storage', snapshot.security?.encrypted ? 'Хранилище подписок защищено safeStorage' : 'Системное шифрование недоступно или это preview');
      if (api.isDesktop) {
        const autostart = await api.system.autostartStatus();
        $('#autostart-toggle').checked = Boolean(autostart.enabled);

      } else toast('Режим preview', 'Сетевые движки работают только в Windows-приложении.', 'info');
    } catch (error) {
      toast('Ошибка запуска', error.message, 'error'); addLog('error', 'System', error.message); renderEverything();
    }
  }

  initialize();
})();
