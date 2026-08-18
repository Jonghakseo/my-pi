(() => {
  const themeButton = document.querySelector('[data-action="toggle-theme"]');
  if (themeButton) {
    const labels = { auto: '테마: 자동', light: '테마: 라이트', dark: '테마: 다크' };
    const order = ['auto', 'light', 'dark'];
    let theme = 'auto';
    try {
      const stored = localStorage.getItem('easy-review-theme');
      if (order.includes(stored)) theme = stored;
    } catch { /* file:// 등 저장소 접근 불가 시 자동 모드 유지 */ }
    const applyTheme = () => {
      if (theme === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      themeButton.textContent = labels[theme];
    };
    themeButton.addEventListener('click', () => {
      theme = order[(order.indexOf(theme) + 1) % order.length];
      try { localStorage.setItem('easy-review-theme', theme); } catch { /* 저장 실패해도 현재 문서에는 적용 */ }
      applyTheme();
    });
    applyTheme();
  }

  const expandButton = document.querySelector('[data-action="expand-all"]');
  if (expandButton) {
    expandButton.addEventListener('click', () => {
      const details = Array.from(document.querySelectorAll('details.review-section, details.inline-fold, details.supporting-files'));
      const shouldOpen = details.some((item) => !item.open);
      details.forEach((item) => { item.open = shouldOpen; });
      expandButton.textContent = shouldOpen ? '전체 접기' : '전체 펼치기';
    });
  }

  const anchorButton = document.querySelector('[data-action="toggle-anchors"]');
  if (anchorButton) {
    anchorButton.addEventListener('click', () => {
      document.body.classList.toggle('show-anchor-ids');
      anchorButton.textContent = document.body.classList.contains('show-anchor-ids')
        ? '근거 ID 숨기기'
        : '근거 ID 보기';
    });
  }

  const revealLinkedContent = () => {
    if (!window.location.hash) return;
    const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
    if (!target) return;
    if (target.matches('details')) target.open = true;
    let parent = target.closest('details');
    while (parent) {
      parent.open = true;
      parent = parent.parentElement?.closest('details');
    }
  };
  window.addEventListener('hashchange', revealLinkedContent);
  revealLinkedContent();

  if (window.Prism) {
    window.Prism.highlightAllUnder(document.querySelector('.shell'));
  }

  const wrapCharRange = (root, start, end) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    const targets = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const from = Math.max(start - offset, 0);
      const to = Math.min(end - offset, node.data.length);
      if (from < to) targets.push({ node, from, to });
      offset += node.data.length;
    }
    targets.forEach(({ node, from, to }) => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const mark = document.createElement('mark');
      mark.className = 'intra';
      range.surroundContents(mark);
    });
  };

  document.querySelectorAll('code[data-intraline]').forEach((code) => {
    code.dataset.intraline.split(' ').forEach((pair) => {
      const [start, end] = pair.split('-').map(Number);
      if (Number.isFinite(start) && Number.isFinite(end) && start < end) wrapCharRange(code, start, end);
    });
  });

  const minimap = document.querySelector('.minimap');
  const minimapToggle = document.querySelector('[data-action="toggle-minimap"]');
  const minimapLinks = Array.from(document.querySelectorAll('[data-minimap-link]'));
  const reviewSections = Array.from(document.querySelectorAll('[data-review-section]'));

  if (minimap && minimapToggle) {
    minimapToggle.addEventListener('click', () => {
      const isOpen = minimap.classList.toggle('is-open');
      minimapToggle.setAttribute('aria-expanded', String(isOpen));
    });
    minimapLinks.forEach((link) => {
      link.addEventListener('click', () => {
        minimap.classList.remove('is-open');
        minimapToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  if (minimapLinks.length && reviewSections.length) {
    const updateMinimap = () => {
      const documentHeight = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      const progress = Math.min(100, Math.max(0, Math.round((window.scrollY / documentHeight) * 100)));
      document.querySelectorAll('[data-minimap-progress]').forEach((item) => {
        item.style.width = `${progress}%`;
      });
      document.querySelectorAll('[data-minimap-percent]').forEach((item) => {
        item.textContent = `${progress}% 읽음`;
      });

      const readingLine = window.scrollY + Math.min(window.innerHeight * 0.32, 280);
      let activeIndex = 0;
      reviewSections.forEach((section, sectionIndex) => {
        if (section.offsetTop <= readingLine) activeIndex = sectionIndex;
      });
      minimapLinks.forEach((link, linkIndex) => {
        link.classList.toggle('active', linkIndex === activeIndex);
        link.classList.toggle('visited', linkIndex < activeIndex);
      });
      const activeLink = minimapLinks[activeIndex];
      const currentLabel = `${String(activeIndex + 1).padStart(2, '0')}/${String(minimapLinks.length).padStart(2, '0')} · ${activeLink.dataset.sectionTitle}`;
      document.querySelectorAll('[data-minimap-current]').forEach((item) => {
        item.textContent = currentLabel;
      });
    };

    let minimapUpdateRequested = false;
    const requestMinimapUpdate = () => {
      if (minimapUpdateRequested) return;
      minimapUpdateRequested = true;
      window.requestAnimationFrame(() => {
        updateMinimap();
        minimapUpdateRequested = false;
      });
    };
    window.addEventListener('scroll', requestMinimapUpdate, { passive: true });
    window.addEventListener('resize', requestMinimapUpdate);
    document.querySelectorAll('details').forEach((item) => item.addEventListener('toggle', requestMinimapUpdate));
    updateMinimap();
  }
})();
