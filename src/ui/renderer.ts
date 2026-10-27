(() => {
  const desktop = window.desktop;
  const input = document.querySelector<HTMLTextAreaElement>('#input')!;
  const statusText = document.querySelector<HTMLParagraphElement>('#status')!;
  const messages = document.querySelector<HTMLElement>('#messages')!;
  const send = document.querySelector<HTMLButtonElement>('#send')!;
  const retry = document.querySelector<HTMLButtonElement>('#retry')!;
  const capture = document.querySelector<HTMLButtonElement>('#capture')!;
  const captureMenu = document.querySelector<HTMLDivElement>('#capture-menu')!;
  let captureState: PublicState['capture'] = { available: false, status: 'empty' };
  let captureScope: 'window' | 'screen' = 'window';
  let captureInFlight = false, captureSequence = 0;
  let captureConnection = '';
  let composing = false, pending = false, busy = false, initial = true, edited = false;
  let sessionId = '', warning = '', captureFeedback = '';
  const nodes = new Map<string, { element: HTMLElement; content: string; status: string }>();
  function feedback(text: string): void { statusText.textContent = text || captureFeedback || warning; statusText.hidden = !statusText.textContent; }
  function resizeInput(): void { input.style.height = '24px'; window.pet?.resizeComposer(42); }
  function saveDraft(): void { void desktop.saveDraft(input.value, sessionId).catch(() => feedback('草稿尚未保存，请检查输入长度或稍后重试。')); }
  function closeCaptureMenu(): void { captureMenu.hidden = true; capture.setAttribute('aria-expanded', 'false'); }
  function renderCapture(): void {
    const capturing = captureInFlight || captureState.status === 'capturing';
    capture.dataset.state = capturing ? 'capturing' : captureState.status;
    capture.disabled = !captureState.available || capturing || busy || pending;
    capture.setAttribute('aria-busy', String(capturing));
    const target = captureScope === 'screen' ? '整个屏幕' : '前台窗口';
    capture.setAttribute('aria-label', capturing ? '正在截图' : captureState.status === 'ready' ? '管理本次截图' : '截取' + target);
    capture.title = !captureState.available ? captureState.reason || '当前连接暂不支持截图' : capturing ? '正在截图' : captureState.status === 'ready' ? '已附上画面，点击可重新截图或移除' : '截取' + target + '，随下一条消息发送' + (captureState.reason ? '。' + captureState.reason : '');
    capture.querySelector<HTMLElement>('.capture-dot')!.hidden = captureState.status !== 'ready' || capturing;
    if (!captureState.available || capturing || busy || captureState.status !== 'ready') closeCaptureMenu();
  }
  async function requestCapture(): Promise<void> {
    if (capture.disabled) return;
    const sequence = ++captureSequence;
    captureFeedback = ''; feedback(''); captureInFlight = true; renderCapture();
    try {
      const result = await desktop.captureWindow();
      if (sequence === captureSequence) { captureFeedback = result.error; feedback(''); }
    } catch { if (sequence === captureSequence) { captureFeedback = '未能读取画面'; feedback(''); } }
    finally { if (sequence === captureSequence) { captureInFlight = false; renderCapture(); } }
  }
  capture.addEventListener('click', () => {
    if (captureState.status === 'ready') { captureMenu.hidden = !captureMenu.hidden; capture.setAttribute('aria-expanded', String(!captureMenu.hidden)); }
    else void requestCapture();
  });
  document.querySelector('#capture-retake')!.addEventListener('click', () => { closeCaptureMenu(); void requestCapture(); });
  document.querySelector('#capture-remove')!.addEventListener('click', () => {
    closeCaptureMenu(); captureFeedback = ''; const sequence = ++captureSequence;
    void desktop.clearCapture().then(result => { if (sequence === captureSequence) feedback(result.error); }).catch(() => { if (sequence === captureSequence) feedback('暂时无法移除截图，请重试。'); });
  });
  document.addEventListener('pointerdown', event => { const target = event.target as Node; if (!capture.contains(target) && !captureMenu.contains(target)) closeCaptureMenu(); });
  // Only DOM text nodes: model HTML is never interpreted as markup.
  function inline(parent: HTMLElement, text: string): void {
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      parent.append(document.createTextNode(text.slice(offset, match.index)));
      const token = match[0]; let node: HTMLElement;
      if (token.startsWith('`')) { node = document.createElement('code'); node.textContent = token.slice(1, -1); }
      else if (token.startsWith('**')) { node = document.createElement('strong'); node.textContent = token.slice(2, -2); }
      else {
        const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
        const anchor = document.createElement('a'); anchor.textContent = parts[1]!; anchor.href = parts[2]!;
        anchor.addEventListener('click', event => { event.preventDefault(); void desktop.openLink(parts[2]!).catch(() => feedback('无法打开该链接。')); }); node = anchor;
      }
      parent.append(node); offset = match.index! + token.length;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }
  function markdown(parent: HTMLElement, text: string): void {
    const lines = text.split('\n'); let code: string[] | null = null;
    let list: HTMLOListElement | HTMLUListElement | null = null;
    const flushCode = (): void => { const pre = document.createElement('pre'); const body = document.createElement('code'); body.textContent = code!.join('\n'); pre.append(body); parent.append(pre); code = null; };
    for (const line of lines) {
      if (line.startsWith('```')) { list = null; if (code) flushCode(); else code = []; continue; }
      if (code) { code.push(line); continue; }
      const item = /^\s*(?:([-*])|\d+\.)\s+(.+)$/.exec(line);
      if (item) {
        const tag = item[1] ? 'UL' : 'OL';
        if (!list || list.tagName !== tag) { list = document.createElement(tag === 'UL' ? 'ul' : 'ol'); parent.append(list); }
        const li = document.createElement('li'); inline(li, item[2]!); list.append(li); continue;
      }
      list = null;
      if (!line.trim()) { const gap = document.createElement('div'); gap.className = 'paragraph-gap'; parent.append(gap); continue; }
      const paragraph = document.createElement('div'); inline(paragraph, line); parent.append(paragraph);
    }
    if (code) flushCode();
  }
  function render(state: PublicState): void {
    window.pet?.configure(state.settings);
    const newSession = sessionId !== state.session.id;
    const connection = JSON.stringify([state.settings.provider, state.settings.baseUrl, state.settings.model, state.settings.cliModel]);
    if (newSession || captureConnection !== connection || captureScope !== (state.settings.captureScope ?? 'window') || (captureState.available && !state.capture?.available)) { captureSequence++; captureInFlight = false; captureFeedback = ''; closeCaptureMenu(); }
    captureConnection = connection;
    if (newSession) { nodes.clear(); messages.replaceChildren(); sessionId = state.session.id; }
    if ((initial && !edited) || (newSession && !initial)) { input.value = state.session.draft; resizeInput(); }
    initial = false; busy = state.busy; warning = state.warning;
    captureState = state.capture ?? { available: false, status: 'empty' };
    captureScope = state.settings.captureScope ?? 'window';
    renderCapture();
    document.documentElement.style.setProperty('--message-size', `${state.settings.fontSize}px`);
    document.documentElement.style.setProperty('--message-color', state.settings.textColor ?? '#000000');
    document.body.classList.toggle('text-shadow', state.settings.textShadow);
    const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 40;
    const ids = new Set(state.session.messages.map(m => m.id));
    for (const [id, node] of nodes) if (!ids.has(id)) { node.element.remove(); nodes.delete(id); }
    for (const message of state.session.messages) {
      let node = nodes.get(message.id);
      if (!node) { const element = document.createElement('article'); element.className = `message ${message.role}`; messages.append(element); node = { element, content: '', status: '' }; nodes.set(message.id, node); }
      const status = message.status + (message.error ?? '') + (message.notice ?? '');
      if (node.content !== message.content || node.status !== status) {
        node.element.replaceChildren();
        if (message.role === 'assistant') markdown(node.element, message.content); else node.element.textContent = message.content;
        // Keep capture diagnostics in history/model input; show a brief label, including older messages.
        if (message.notice) { const note = document.createElement('small'); note.className = 'message-state'; note.textContent = '未能读取画面'; node.element.append(note); }
        if (message.status !== 'complete') {
          const note = document.createElement('small'); note.className = 'message-state';
          note.textContent = message.status === 'generating' ? (message.content ? '正在生成…' : '正在等待回复…') : message.error || '回答未完成。';
          node.element.append(note);
        }
        node.content = message.content; node.status = status;
      }
    }
    // Imported desktop turns can arrive before an existing pending user message.
    let previous: HTMLElement | null = null;
    for (const message of state.session.messages) {
      const element = nodes.get(message.id)!.element;
      if (element.previousElementSibling !== previous) messages.insertBefore(element, previous ? previous.nextSibling : messages.firstChild);
      previous = element;
    }
    if (atBottom || newSession) messages.scrollTop = messages.scrollHeight;
    send.setAttribute('aria-label', busy ? '停止生成' : '发送'); send.classList.toggle('stop', busy);
    const last = state.session.messages.at(-1);
    retry.hidden = busy || !last || last.role !== 'assistant' || !['failed', 'cancelled', 'interrupted'].includes(last.status);
    feedback('');
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; saveDraft(); });
  input.addEventListener('input', () => { edited = true; captureFeedback = ''; feedback(''); resizeInput(); saveDraft(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault(); if (!busy) void submit();
    }
  });
  async function submit(): Promise<void> {
    if (pending || composing) return;
    if (busy) { await desktop.stop(); return; }
    if (captureInFlight || captureState.status === 'capturing') return;
    if (!input.value.trim()) return;
    pending = true; captureFeedback = ''; renderCapture(); const submitted = input.value, submittedSession = sessionId;
    try {
      const response = await desktop.submit(submitted, submittedSession);
      if (sessionId !== submittedSession) return;
      if (response.ok) { if (input.value === submitted) input.value = ''; resizeInput(); saveDraft(); }
      feedback(response.error);
    } catch { feedback('暂时无法发送，请稍后重试。输入已保留。'); }
    finally { pending = false; renderCapture(); }
  }
  document.querySelector('#composer')!.addEventListener('submit', event => { event.preventDefault(); void submit().catch(() => feedback('停止请求失败，请重试。')); });
  retry.addEventListener('click', async () => { if (pending) return; pending = true; try { const result = await desktop.retry(); feedback(result.error); } catch { feedback('重试失败，请稍后重试。'); } finally { pending = false; } });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing && !composing) {
    if (!captureMenu.hidden) { closeCaptureMenu(); capture.focus(); } else void desktop.setMode('collapsed');
  } });
  let latestMode: import('../window-state').WindowMode | undefined;
  desktop.onMode(mode => { if (mode !== 'expanded' && mode !== 'collapsed' && mode !== 'hidden') return; latestMode = mode; document.body.dataset.mode = mode; if (mode !== 'expanded') { closeCaptureMenu(); if (!initial || edited) saveDraft(); } window.pet?.setMode(mode); if (mode === 'expanded') requestAnimationFrame(resizeInput); });
  window.addEventListener('pet-ready', () => { if (latestMode) window.pet?.setMode(latestMode); resizeInput(); void desktop.getState().then(render); });
  desktop.onState(render);
  void desktop.getState().then(render).catch(() => feedback('无法读取当前会话。'));
})();
