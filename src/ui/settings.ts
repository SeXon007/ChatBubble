(() => {
  type Field = import('../settings').SettingsField;
  type Patch = import('../settings').SettingsPatch;
  type Config = import('../model').Settings;
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const input = (id: string): HTMLInputElement => $(id);
  const result = $('result');
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
  function selectTab(tab: HTMLButtonElement): void {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected)); item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')!).hidden = !selected;
    }
    $('check').hidden = tab.id !== 'tab-connection';
    report();
    fitSettings(true);
    if (tab.id === 'tab-connection' && !loading) { lastApiLookup = ''; autoApiModels(); }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); selectTab(tabs[next]!); tabs[next]!.focus();
    });
  });
  let saved: PublicState, draft: Config;
  let candidates: Awaited<ReturnType<DesktopBridge['discoverCli']>> = [];
  let catalog: Awaited<ReturnType<DesktopBridge['getModelCatalog']>> = { models: [], source: '', fetchedAt: '' };
  let apiServices: import('../api-models').ApiPreset[] = [], apiCatalog: import('../api-models').ApiModelCatalog | undefined;
  let apiManual = false, apiCustomService = false, apiLoading = false, apiNotice = '', apiRequest = 0, apiKeyGeneration = 0, lastApiLookup = '';
  let loading = true, operating = false, manual = false, selectedArchive = '';
  let selectedArchiveSession: import('../model').Session | undefined;
  let archiveRequest = 0;
  let versionNotice = '点击“检查更新”读取 GitHub 最新版本。', versionError = false;
  let updateState: import('../updates').UpdateState = { phase: 'idle', message: versionNotice };
  let desktopClientStatus: import('../desktop-client').DesktopClientStatus | undefined;
  let clientHistoryKey: string | undefined, clientHistoryRequested: string | undefined, clientHistoryRequest = 0;
  let serial: Promise<void> = Promise.resolve(), sequence = 0;
  const dirty = new Set<string>(), revisions = new Map<string, number>(), errors = new Map<string, string>();
  const timers = new Map<Field, ReturnType<typeof setTimeout>>();
  let sizeFrame = 0, resetSize = false;
  function fitSettings(resetWidth = false): void {
    resetSize ||= resetWidth;
    if (sizeFrame) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = 0;
      const reset = resetSize; resetSize = false;
      void window.desktop.resizeSettings($('settings-shell').getBoundingClientRect().height, reset).catch(() => {});
    });
  }
  const scheduled = new Map<string, number | undefined>(), composing = new Set<Field>();
  const labels: Record<string, string> = { none: '不额外推理', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高', ultra: '超高' };
  function status(text: string, error = false): void {
    const version = $('tab-version').getAttribute('aria-selected') === 'true';
    result.textContent = version ? versionNotice : text;
    result.dataset.error = String(version ? versionError : error);
  }
  function report(): void {
    document.querySelectorAll<HTMLOutputElement>('[data-value]').forEach(node => { node.value = String(draft?.[node.dataset.value as keyof Config] ?? '') + (node.dataset.unit || ''); });
    const error = errors.values().next().value;
    status(error || (dirty.size ? '保存中…' : apiLoading ? '读取模型…' : draft?.provider === 'api' && apiNotice ? apiNotice : '已自动保存'), !!error);
  }
  function lock(): void {
    document.querySelectorAll<HTMLInputElement>('[data-edit]').forEach(node => { node.disabled = loading || operating || !!saved?.busy; });
    $('restore-archive').toggleAttribute('disabled', !selectedArchive || operating || !!saved?.busy);
    if (apiLoading) input('api-model-refresh').disabled = true;
  }
  function put(field: Field, value: unknown): void {
    Object.assign(draft, { [field]: value }); dirty.add(field); revisions.set(field, ++sequence); errors.delete(field);
    input(field === 'cliModel' ? 'cliModel' : field)?.removeAttribute('aria-invalid');
  }
  function options(): void {
    const choice = $<HTMLSelectElement>('cli-model-choice');
    choice.replaceChildren(new Option('CLI 默认', ''));
    for (const model of catalog.models) choice.add(new Option(model.id, model.id));
    choice.add(new Option('手动填写…', '__custom__'));
    choice.value = manual ? '__custom__' : draft.cliModel || '';
    const effort = $<HTMLSelectElement>('reasoningEffort'), model = catalog.models.find(m => m.id === draft.cliModel);
    effort.replaceChildren(new Option('模型默认', ''));
    for (const level of model?.efforts.length ? model.efforts : Object.keys(labels)) effort.add(new Option(labels[level] || level, level));
    if (draft.reasoningEffort && !Array.from(effort.options).some(option => option.value === draft.reasoningEffort)) effort.add(new Option((labels[draft.reasoningEffort] || draft.reasoningEffort) + '（待确认）', draft.reasoningEffort));
    effort.value = draft.reasoningEffort || '';
    choice.title = model ? catalog.source + (model.contextWindow ? '；窗口缓存：' + model.contextWindow.toLocaleString('zh-CN') + ' tokens' : '') : '使用 CLI 默认时，实际型号未确认；可手动填写。';
  }
  function apiService(): import('../api-models').ApiPreset | undefined {
    const normal = (url: string): string => url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return apiServices.find(service => [service.baseUrl, ...(service.aliases ?? [])].some(url => normal(url) === normal(draft.baseUrl)));
  }
  function apiOptions(): void {
    const service = apiService(), select = $<HTMLSelectElement>('api-service');
    select.replaceChildren(new Option('自定义', 'custom'), ...apiServices.map(item => new Option(item.name, item.id)));
    select.value = apiCustomService ? 'custom' : service?.id ?? 'custom';
    const matching = apiCatalog?.baseUrl === draft.baseUrl ? apiCatalog : undefined;
    const models = matching?.models ?? service?.models ?? [];
    const choice = $<HTMLSelectElement>('api-model-choice'), placeholder = new Option(apiLoading ? '读取中…' : '选择模型', '');
    placeholder.disabled = true; choice.replaceChildren(placeholder);
    const visible = models.slice(0, 4), names = matching?.names ?? (matching?.source === 'service' ? undefined : service?.names);
    for (const model of visible) choice.add(new Option(names?.[model] || model, model));
    if (draft.model && !visible.includes(draft.model)) choice.add(new Option((names?.[draft.model] || draft.model) + '（当前配置）', draft.model));
    choice.add(new Option('手动填写…', '__custom__')); choice.value = apiManual ? '__custom__' : draft.model || '';
    choice.title = (matching?.source === 'service' ? '厂商模型目录，优先显示最近的四个；打开连接页或点击刷新可更新。' : service ? '内置常用候选，实际可用性取决于当前账户权限。' : '可刷新服务模型列表，或手动填写模型名称。') + (draft.model ? ' 当前 API ID：' + draft.model : '');
    $('api-model-refresh').title = service && !service.listModels ? '此服务提供常用模型候选，仍可手动填写。' : '读取当前服务的模型列表';
    const effort = $<HTMLSelectElement>('apiReasoningEffort'), levels = service?.efforts?.[draft.model] ?? [];
    effort.replaceChildren(new Option(levels.length ? '模型默认' : '模型默认（能力未确认）', ''));
    for (const level of levels) effort.add(new Option(level === 'none' ? '关闭思考' : labels[level] || level, level));
    effort.value = draft.apiReasoningEffort || '';
    effort.title = levels.length ? '使用当前模型支持的思考强度；越高可能耗时更长、消耗更多 token。' : '当前模型未确认支持可调思考强度，使用厂商默认。';
  }
  async function refreshApiModels(automatic = false): Promise<void> {
    if (loading || (draft.provider || 'api') !== 'api') return;
    if (automatic) {
      if (dirty.has('baseUrl') || dirty.has('key') || saved.settings.baseUrl !== draft.baseUrl) return;
    } else if (!await flush()) return;
    const baseUrl = draft.baseUrl;
    if (!baseUrl) return;
    const request = ++apiRequest; apiLoading = true; apiNotice = ''; render(); report();
    try {
      const response = await window.desktop.getApiModels(baseUrl);
      if (request !== apiRequest || draft.baseUrl !== baseUrl || (draft.provider || 'api') !== 'api' || dirty.has('baseUrl') || dirty.has('key')) return;
      apiCatalog = response; apiNotice = response.error;
    } catch { if (request === apiRequest && draft.baseUrl === baseUrl) apiNotice = '未能获取模型，仍可手动填写。'; }
    finally { if (request === apiRequest) { apiLoading = false; render(); if (!operating) report(); } }
  }
  function autoApiModels(): void {
    if ((draft.provider || 'api') !== 'api' || !saved.hasKey || dirty.has('key') || dirty.has('baseUrl') || saved.settings.baseUrl !== draft.baseUrl) return;
    const identity = draft.baseUrl + '\0' + apiKeyGeneration;
    if (identity !== lastApiLookup) { lastApiLookup = identity; void refreshApiModels(true); }
  }
  function renderHistoryEntry(refresh = false): void {
    const api = (draft.provider || 'api') === 'api', key = api ? draft.baseUrl : undefined;
    const codex = draft.provider === 'codex-cli', nativeButton = $<HTMLButtonElement>('open-codex');
    const binding = (selectedArchive ? selectedArchiveSession : saved.session)?.codex;
    nativeButton.hidden = !codex;
    nativeButton.disabled = saved.settings.provider !== 'codex-cli' || !binding;
    nativeButton.textContent = selectedArchive ? '在 Codex 中查看所选对话' : '在 Codex 中查看当前对话';
    const codexNotice = $('codex-history-notice');
    codexNotice.hidden = !codex || !!binding;
    codexNotice.textContent = selectedArchive ? (selectedArchiveSession ? '所选对话没有 Codex 原生会话，仍可在 ChatBubble 中查看。' : '正在读取所选对话…')
      : '当前对话尚未创建 Codex 原生会话；可选择下方已有的 Codex 历史对话，或发送消息后查看当前对话。';
    if (key !== clientHistoryKey) {
      clientHistoryKey = key; desktopClientStatus = undefined; clientHistoryRequested = undefined; clientHistoryRequest++;
    }
    const notice = $('client-history-notice'), button = $<HTMLButtonElement>('open-client');
    notice.hidden = !api; button.hidden = !api || !desktopClientStatus?.name;
    notice.textContent = desktopClientStatus?.notice || '此 API 对话保存在 ChatBubble，暂不支持在对应客户端中查看。';
    button.textContent = desktopClientStatus?.name ? '打开 ' + desktopClientStatus.name : '';
    if (!api || !$<HTMLDialogElement>('history-dialog').open || loading || dirty.has('provider') || dirty.has('baseUrl') || saved.settings.baseUrl !== draft.baseUrl) return;
    if (!refresh && clientHistoryRequested === key) return;
    clientHistoryRequested = key; const request = ++clientHistoryRequest;
    void window.desktop.getDesktopClientStatus().then(response => {
      if (request !== clientHistoryRequest || response.baseUrl !== draft.baseUrl || (draft.provider || 'api') !== 'api') return;
      desktopClientStatus = response; renderHistoryEntry();
    }).catch(() => {
      if (request !== clientHistoryRequest) return;
      notice.textContent = '暂时无法检测对应客户端。此 API 对话仍保存在 ChatBubble。';
    });
  }
  function render(): void {
    if (!draft) return;
    const api = (draft.provider || 'api') === 'api', codex = draft.provider === 'codex-cli';
    input('provider').value = draft.provider || 'api';
    $('program-row').hidden = api; $('url-row').hidden = !api;
    $('model-row').hidden = !codex; $('custom-model-row').hidden = api || (codex && !manual);
    $('api-service-row').hidden = !api; $('api-model-choice-row').hidden = !api; $('api-model-row').hidden = !api || !apiManual;
    $('key-row').hidden = !api; $('effort-row').hidden = !codex;
    $('api-effort-row').hidden = !api;
    $('cli-model-label').textContent = codex ? '模型名称' : '模型';
    document.querySelectorAll<HTMLInputElement>('[data-field]').forEach(node => {
      const field = node.dataset.field as keyof Config;
      const value = field === 'textColor' ? draft.textColor ?? '#000000' : field === 'captureScope' ? draft.captureScope ?? 'window' : draft[field];
      if (node.type === 'checkbox') node.checked = !!value;
      else if (node.value !== String(value ?? '')) node.value = String(value ?? '');
    });
    document.querySelectorAll<HTMLOutputElement>('[data-value]').forEach(node => { node.value = String(draft[node.dataset.value as keyof Config] ?? '') + (node.dataset.unit || ''); });
    options(); apiOptions();
    const matchingKey = saved?.settings.baseUrl === draft.baseUrl && saved?.hasKey;
    input('key').placeholder = matchingKey ? '已保存，输入替换' : '未设置';
    $('clear-key').hidden = !matchingKey;
    if (saved) {
      input('storage-directory').value = saved.storage.directory;
      input('storage-directory').title = saved.storage.directory + '（双击打开）';
      renderHistoryEntry();
    }
    lock();
  }
  function receive(state: PublicState): void {
    const wasBusy = saved?.busy;
    const changedSession = saved && saved.session.id !== state.session.id;
    saved = state;
    if (changedSession) {
      archiveRequest++; selectedArchive = ''; selectedArchiveSession = undefined;
      $<HTMLSelectElement>('archive-list').replaceChildren(new Option('选择一段对话…', '')); $('archive-preview').hidden = true;
      $('history').textContent = '查看'; $('archive-status').textContent = '';
      if ($<HTMLDialogElement>('history-dialog').open) void refreshArchives().catch(() => { $('archive-status').textContent = '历史记录读取失败。'; });
    }
    if (!draft) draft = { messageHeight: 380, ...state.settings, provider: state.settings.provider || 'api' };
    for (const [field, value] of Object.entries(state.settings)) if (!dirty.has(field)) Object.assign(draft, { [field]: value });
    render();
    if (!loading) autoApiModels();
    if (wasBusy && !state.busy && dirty.size) { commitText(); retryChanges(); }
  }
  function enqueue(patch: Patch | { key: string; keyEndpoint: string }, fields: string[]): void {
    const stamps = new Map(fields.map(field => [field, revisions.get(field)]));
    if (fields.every(field => scheduled.has(field) && scheduled.get(field) === stamps.get(field))) return;
    for (const field of fields) scheduled.set(field, stamps.get(field));
    serial = serial.catch(() => {}).then(async () => {
      try {
        const response = await window.desktop.saveSettings(patch);
        for (const field of fields) if (revisions.get(field) === stamps.get(field)) {
          if (response.ok) { dirty.delete(field); errors.delete(field); }
          else errors.set(field, response.error);
          const node = document.getElementById(field);
          if (node) node.setAttribute('aria-invalid', String(!response.ok));
        }
        if ('key' in patch && response.ok && revisions.get('key') === stamps.get('key')) { input('key').value = ''; apiKeyGeneration++; }
        receive(await window.desktop.getState());
      } catch {
        for (const field of fields) if (revisions.get(field) === stamps.get(field)) errors.set(field, '自动保存失败，请重新编辑重试。');
      }
      report();
      for (const field of fields) if (scheduled.get(field) === stamps.get(field)) scheduled.delete(field);
    });
  }
  function savePatch(patch: Patch): void {
    for (const [field, value] of Object.entries(patch)) put(field as Field, value);
    enqueue(patch, Object.keys(patch)); render(); report();
  }
  function saveText(field: Field): void {
    clearTimeout(timers.get(field)); timers.delete(field);
    if (!dirty.has(field)) return;
    if (field === 'cliModel') {
      const supported = catalog.models.find(m => m.id === draft.cliModel)?.efforts;
      if (supported?.length && draft.reasoningEffort && !supported.includes(draft.reasoningEffort)) {
        put('reasoningEffort', ''); enqueue({ cliModel: draft.cliModel, reasoningEffort: '' }, ['cliModel', 'reasoningEffort']); return;
      }
    }
    enqueue({ [field]: draft[field] }, [field]);
  }
  function saveKey(): void {
    if (!dirty.has('key')) return;
    if (timers.has('baseUrl')) saveText('baseUrl');
    enqueue({ key: input('key').value, keyEndpoint: draft.baseUrl }, ['key']);
  }
  function commitText(): void { for (const field of [...timers.keys()]) saveText(field); saveKey(); }
  function retryChanges(): void {
    const patch: Patch = {};
    for (const field of dirty) if (field !== 'key') Object.assign(patch, { [field]: draft[field as Field] });
    if (Object.keys(patch).length) enqueue(patch, Object.keys(patch));
  }
  async function flush(): Promise<boolean> {
    if (composing.size) return false;
    commitText(); await serial;
    // A failed edit remains visible; closing never silently discards it.
    return dirty.size === 0;
  }
  window.flushSettings = flush;
  async function act(operation: () => Promise<void>, requireClean = true): Promise<void> {
    if (operating) return;
    operating = true; lock();
    try { const clean = await flush(); if (requireClean && !clean) return; await operation(); } catch { status('操作失败，请重试。', true); }
    finally { operating = false; lock(); }
  }
  $('settings').addEventListener('submit', event => { event.preventDefault(); void flush(); });
  document.querySelectorAll<HTMLInputElement>('[data-field]').forEach(node => {
    const field = node.dataset.field as Field, immediate = node.tagName === 'SELECT' || node.type === 'checkbox';
    node.addEventListener(immediate ? 'change' : 'input', () => {
      const value = node.type === 'checkbox' ? node.checked : field === 'fontSize' || node.type === 'range' ? Number(node.value) : node.value;
      put(field, value); report();
      if (immediate) enqueue({ [field]: value }, [field]);
      else if (!composing.has(field)) { clearTimeout(timers.get(field)); timers.set(field, setTimeout(() => saveText(field), 350)); }
    });
    if (!immediate) node.addEventListener('blur', () => { if (timers.has(field)) saveText(field); });
    if (node.type === 'range' || node.type === 'color') node.addEventListener('change', () => { if (timers.has(field)) saveText(field); });
    node.addEventListener('compositionstart', () => { composing.add(field); clearTimeout(timers.get(field)); timers.delete(field); });
    node.addEventListener('compositionend', () => { composing.delete(field); if (dirty.has(field)) timers.set(field, setTimeout(() => saveText(field), 350)); });
  });
  input('key').addEventListener('input', () => { dirty.add('key'); revisions.set('key', ++sequence); errors.delete('key'); status('结束编辑后自动保存'); });
  input('key').addEventListener('blur', saveKey);
  $('clear-key').addEventListener('click', () => { input('key').value = ''; dirty.add('key'); revisions.set('key', ++sequence); saveKey(); });
  input('provider').addEventListener('change', () => {
    commitText();
    const provider = input('provider').value as Config['provider'];
    const patch: Patch = { provider };
    if (provider !== 'api') { patch.cliPath = candidates.find(c => c.kind === provider && c.usable)?.path || ''; patch.cliModel = ''; patch.reasoningEffort = ''; }
    manual = false; savePatch(patch);
  });
  input('cli-model-choice').addEventListener('change', () => {
    commitText();
    const value = input('cli-model-choice').value;
    if (value === '__custom__') { manual = true; render(); input('cliModel').focus(); return; }
    manual = false;
    const supported = catalog.models.find(m => m.id === value)?.efforts;
    savePatch({ cliModel: value, reasoningEffort: supported?.includes(draft.reasoningEffort || '') ? draft.reasoningEffort : '' });
  });
  input('api-service').addEventListener('change', () => {
    commitText(); apiRequest++; apiLoading = false; apiNotice = ''; apiCatalog = undefined; lastApiLookup = '';
    const service = apiServices.find(item => item.id === input('api-service').value);
    apiCustomService = !service; apiManual = false;
    if (service && service.baseUrl !== draft.baseUrl) savePatch({ baseUrl: service.baseUrl, model: '' });
    else render();
  });
  input('api-model-choice').addEventListener('change', () => {
    const value = input('api-model-choice').value;
    if (value === '__custom__') { apiManual = true; render(); input('model').focus(); return; }
    if (value) { apiManual = false; savePatch({ model: value }); }
  });
  $('api-model-refresh').addEventListener('click', () => { void refreshApiModels(); });
  $('pick-cli').addEventListener('click', () => { void act(async () => {
    const path = await window.desktop.pickCli();
    if (path) { put('cliPath', path); enqueue({ cliPath: path }, ['cliPath']); render(); await serial; }
  }, false); });
  $('choose-storage').addEventListener('click', () => { void act(async () => {
    const response = await window.desktop.chooseStorage();
    if (response.ok) { receive(await window.desktop.getState()); status('存储位置已更新'); }
    else if (!response.cancelled) status(response.error, true);
  }); });
  $('storage-directory').addEventListener('dblclick', () => { void window.desktop.openStorage('chat').then(r => { if (!r.ok) status(r.error, true); }); });
  $('check').addEventListener('click', () => { void act(async () => {
    status('检查中…');
    const response = await window.desktop.checkConnection();
    status(response.ok ? '连接成功' : response.error, !response.ok);
  }); });
  function renderUpdate(state: import('../updates').UpdateState): void {
    updateState = state; versionNotice = state.message; versionError = state.phase === 'error';
    const busy = state.phase === 'checking' || state.phase === 'downloading';
    $<HTMLButtonElement>('check-update').disabled = busy || state.phase === 'ready';
    const button = $<HTMLButtonElement>('open-update');
    button.disabled = !['available', 'ready'].includes(state.phase);
    button.textContent = state.phase === 'ready' ? '重启并更新' : state.phase === 'downloading' ? '准备更新…' : '更新';
    if ($('tab-version').getAttribute('aria-selected') === 'true') report();
  }
  $('check-update').addEventListener('click', () => {
    renderUpdate({ phase: 'checking', message: '正在检查 GitHub 更新…' });
    void window.desktop.checkUpdates().then(renderUpdate).catch(() => renderUpdate({ phase: 'error', message: '检查更新失败，请稍后重试。' }));
  });
  $('open-update').addEventListener('click', () => {
    const restart = updateState.phase === 'ready';
    if (!restart) renderUpdate({ phase: 'downloading', message: '正在准备下载更新…' });
    void (restart ? window.desktop.restartForUpdate() : window.desktop.downloadUpdate()).then(renderUpdate)
      .catch(() => renderUpdate({ phase: 'error', message: '更新失败，当前版本和聊天记录已保留。' }));
  });
  window.desktop.onUpdate(renderUpdate);
  void window.desktop.getUpdateState().then(renderUpdate).catch(() => renderUpdate({ phase: 'error', message: '无法读取更新状态，请重新打开设置。' }));
  void window.desktop.getAppVersion().then(version => {
    $('current-version').textContent = version;
  }).catch(() => {
    $('current-version').textContent = '无法读取';
    versionNotice = '无法读取版本，请重新打开设置。'; versionError = true;
    if ($('tab-version').getAttribute('aria-selected') === 'true') report();
  });
  async function refreshArchives(): Promise<void> {
    const request = ++archiveRequest, sessionId = saved.session.id;
    const response = await window.desktop.listArchives(), list = $<HTMLSelectElement>('archive-list');
    if (request !== archiveRequest || sessionId !== saved.session.id) return;
    list.replaceChildren(new Option('选择一段对话…', ''));
    for (const item of response.items) list.add(new Option(new Date(item.createdAt).toLocaleDateString('zh-CN') + ' · ' + item.title, item.id));
    if (response.items.some(item => item.id === selectedArchive)) list.value = selectedArchive;
    else { selectedArchive = ''; selectedArchiveSession = undefined; $('archive-preview').hidden = true; }
    renderHistoryEntry();
    $('archive-status').textContent = [response.unreadable ? response.unreadable + ' 份归档无法读取，原文件已保留。' : response.items.length ? '' : '当前连接暂无历史对话。',
      response.unclassified ? response.unclassified + ' 份旧记录来源未分类，已保留在本地文件夹，不参与混用。' : ''].filter(Boolean).join(' ');
    $('history').textContent = response.items.length ? '查看 ' + response.items.length + ' 段对话' : '查看';
    lock();
  }
  $('history').addEventListener('click', async () => {
    if (!$<HTMLDialogElement>('history-dialog').open) $<HTMLDialogElement>('history-dialog').showModal();
    renderHistoryEntry(true);
    try { await refreshArchives(); } catch { $('archive-status').textContent = '历史记录读取失败。'; }
  });
  $('close-history').addEventListener('click', () => $<HTMLDialogElement>('history-dialog').close());
  $('refresh-archives').addEventListener('click', () => { void refreshArchives().catch(() => { $('archive-status').textContent = '历史记录读取失败。'; }); });
  $('archive-list').addEventListener('change', async () => {
    const id = input('archive-list').value; selectedArchive = id;
    const sessionId = saved.session.id;
    selectedArchiveSession = undefined; renderHistoryEntry();
    $('archive-preview').hidden = !id; lock(); if (!id) return;
    try {
      const session = await window.desktop.readArchive(id);
      if (selectedArchive !== id || sessionId !== saved.session.id) return;
      selectedArchiveSession = session; renderHistoryEntry();
      $('archive-title').textContent = new Date(session.createdAt).toLocaleString('zh-CN');
      const container = $('archive-messages'); container.replaceChildren();
      for (const message of session.messages) {
        const name = document.createElement('strong'); name.textContent = message.role === 'user' ? '你' : '助手';
        const text = document.createElement('p'); text.textContent = message.content || '（无内容）'; container.append(name, text);
      }
      if (session.draft) { const text = document.createElement('p'); text.textContent = '草稿：' + session.draft; container.append(text); }
    } catch { if (selectedArchive !== id || sessionId !== saved.session.id) return; selectedArchive = ''; selectedArchiveSession = undefined; input('archive-list').value = ''; renderHistoryEntry(); $('archive-preview').hidden = true; $('archive-status').textContent = '归档不属于当前连接或无法读取，原文件已保留。'; lock(); }
  });
  $('open-archives').addEventListener('click', () => { void window.desktop.openStorage('archives').then(r => { if (!r.ok) $('archive-status').textContent = r.error; }); });
  $('open-codex').addEventListener('click', () => { void act(async () => {
    const response = await window.desktop.openCodex(selectedArchive || undefined);
    if (!response.ok) $('archive-status').textContent = response.error;
  }); });
  $('open-client').addEventListener('click', () => { void act(async () => {
    const selected = desktopClientStatus;
    if (!selected?.name || selected.baseUrl !== draft.baseUrl) return;
    const response = await window.desktop.openDesktopClient(selected.baseUrl);
    $('client-history-notice').textContent = response.ok ? '已打开 ' + selected.name + '。此 API 对话仍保存在 ChatBubble，暂不支持在该客户端查看。'
      : response.error + ' 此 API 对话仍保存在 ChatBubble。';
  }); });
  $('restore-archive').addEventListener('click', () => { void act(async () => {
    if (!selectedArchive) return;
    const response = await window.desktop.restoreArchive(selectedArchive);
    if (response.ok) { receive(await window.desktop.getState()); await refreshArchives(); $<HTMLDialogElement>('history-dialog').close(); status('对话已恢复'); }
    else if (!response.cancelled) $('archive-status').textContent = response.error;
  }); });
  window.desktop.onState(state => { if (!loading) receive(state); });
  new ResizeObserver(() => fitSettings()).observe($('settings-shell'));
  window.addEventListener('settings-fit', () => fitSettings(true));
  lock();
  void (async () => {
    const [state, models, cli, services] = await Promise.allSettled([window.desktop.getState(), window.desktop.getModelCatalog(), window.desktop.discoverCli(), window.desktop.getApiPresets()]);
    if (state.status !== 'fulfilled') throw new Error();
    if (models.status === 'fulfilled') catalog = models.value;
    if (cli.status === 'fulfilled') candidates = cli.value;
    if (services.status === 'fulfilled') apiServices = services.value;
    saved = state.value; draft = { messageHeight: 380, ...saved.settings, provider: saved.settings.provider || 'api' };
    manual = !!draft.cliModel && !catalog.models.some(m => m.id === draft.cliModel);
    loading = false; render(); autoApiModels();
  })().catch(() => { status('无法读取设置，请重新打开。', true); });
})();
