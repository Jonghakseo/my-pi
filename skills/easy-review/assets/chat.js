(() => {
  const root = document.querySelector('[data-easy-review-chat]');
  if (!root) return;

  const fab = root.querySelector('[data-chat-action="toggle"]');
  const panel = root.querySelector('[data-chat-panel]');
  const closeButton = root.querySelector('[data-chat-action="close"]');
  const resetButton = root.querySelector('[data-chat-action="reset"]');
  const stopButton = root.querySelector('[data-chat-action="stop"]');
  const form = root.querySelector('[data-chat-form]');
  const input = root.querySelector('[data-chat-input]');
  const submitButton = root.querySelector('[data-chat-action="send"]');
  const messages = root.querySelector('[data-chat-messages]');
  const status = root.querySelector('[data-chat-status]');
  const sourceSha = root.dataset.reviewSource || '';
  let connected = false;
  let streaming = false;
  let controller = null;
  let capturedSelection = '';
  const markdown = window.EasyReviewMarkdown;
  const messageText = new WeakMap();

  const setOpen = (open) => {
    panel.hidden = !open;
    fab.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
  };

  const setStatus = (text, state = '') => {
    status.textContent = text;
    status.dataset.state = state;
  };

  const setStreaming = (value) => {
    streaming = value;
    input.disabled = value || !connected;
    submitButton.hidden = value;
    stopButton.hidden = !value;
  };

  const setMessageText = (copy, text, useMarkdown) => {
    messageText.set(copy, text);
    if (useMarkdown && markdown) markdown.render(copy, text);
    else copy.textContent = text;
  };

  const appendMessageText = (copy, delta, useMarkdown) => {
    setMessageText(copy, `${messageText.get(copy) || ''}${delta}`, useMarkdown);
  };

  const addMessage = (role, text = '') => {
    const item = document.createElement('div');
    item.className = `chat-message ${role}`;
    const label = document.createElement('span');
    label.className = 'chat-message-label';
    label.textContent = role === 'user' ? 'YOU' : 'PI';
    const copy = document.createElement('div');
    copy.className = `chat-message-copy${role === 'assistant' ? ' markdown' : ''}`;
    setMessageText(copy, text, role === 'assistant');
    item.append(label, copy);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
    return copy;
  };

  const activeSectionId = () => {
    const sections = Array.from(document.querySelectorAll('[data-review-section]'));
    const readingLine = window.scrollY + Math.min(window.innerHeight * 0.32, 280);
    let active = sections[0] || null;
    sections.forEach((section) => {
      if (section.offsetTop <= readingLine) active = section;
    });
    return active?.dataset.reviewSection || null;
  };

  const reviewSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return '';
    const parent = selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    if (!parent?.closest('.review-content')) return '';
    return selection.toString().trim().slice(0, 4000);
  };

  const captureReviewSelection = () => {
    const selected = reviewSelection();
    if (selected) capturedSelection = selected;
  };

  const apiUrl = (path) => {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}bundle=${encodeURIComponent(sourceSha)}`;
  };

  const apiFetch = (path, options = {}) => fetch(apiUrl(path), {
    ...options,
    credentials: 'same-origin',
  });

  const checkConnection = async () => {
    resetButton.disabled = true;
    if (window.location.protocol === 'file:') {
      connected = false;
      setStatus('localhost 서버로 열어주세요', 'offline');
      input.placeholder = 'easy_review.py serve가 출력한 HTTP 주소에서 대화할 수 있습니다';
      setStreaming(false);
      return;
    }
    try {
      const response = await apiFetch('/api/health', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      connected = health.connected === true;
      setStatus(
        connected ? `리뷰 번들만 참조 · ${health.model || 'Pi SDK'} 연결됨` : '연결 안 됨',
        connected ? 'online' : 'offline',
      );
    } catch {
      connected = false;
      setStatus('로컬 Pi SDK 연결 안 됨', 'offline');
    }
    resetButton.disabled = !connected;
    setStreaming(false);
  };

  const readJsonLines = async (response, onEvent) => {
    if (!response.body) throw new Error('스트리밍 응답을 읽을 수 없습니다.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line));
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  };

  const submit = async () => {
    const message = input.value.trim();
    if (!message || !connected || streaming) return;
    addMessage('user', message);
    input.value = '';
    const answer = addMessage('assistant');
    setStreaming(true);
    setStatus('Pi가 검토 중…', 'working');
    controller = new AbortController();
    try {
      const response = await apiFetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          message,
          sectionId: activeSectionId(),
          selection: capturedSelection,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      await readJsonLines(response, (event) => {
        if (event.type === 'delta') {
          appendMessageText(answer, event.delta, true);
          messages.scrollTop = messages.scrollHeight;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Pi 응답 오류');
        }
      });
      if (!(messageText.get(answer) || '').trim()) {
        setMessageText(answer, '응답 내용이 없습니다.', true);
      }
      setStatus('리뷰 번들만 참조 · Pi SDK 연결됨', 'online');
    } catch (error) {
      if (error.name === 'AbortError') {
        if (!(messageText.get(answer) || '').trim()) setMessageText(answer, '응답을 중단했습니다.', true);
      } else {
        setMessageText(answer, `오류: ${error.message}`, true);
      }
      setStatus('응답을 완료하지 못함', 'offline');
    } finally {
      controller = null;
      setStreaming(false);
    }
  };

  fab.addEventListener('click', () => {
    captureReviewSelection();
    setOpen(panel.hidden);
  });
  document.addEventListener('selectionchange', captureReviewSelection);
  closeButton.addEventListener('click', () => setOpen(false));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });
  stopButton.addEventListener('click', async () => {
    try {
      await apiFetch('/api/abort', { method: 'POST' });
    } finally {
      controller?.abort();
    }
  });
  resetButton.addEventListener('click', async () => {
    if (streaming) return;
    const response = await apiFetch('/api/reset', { method: 'POST' });
    if (!response.ok) {
      setStatus('대화 초기화 실패', 'offline');
      return;
    }
    messages.replaceChildren();
    addMessage('assistant', '대화를 초기화했습니다. 현재 보고 있는 변경에 관해 질문해 보세요.');
    setStatus('리뷰 번들만 참조 · Pi SDK 연결됨', 'online');
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  addMessage('assistant', '현재 보고 있는 변경이나 선택한 코드에 관해 질문해 보세요. 저장소 파일은 읽지 않고 이 리뷰 번들만 참조합니다.');
  setOpen(false);
  checkConnection();
})();
