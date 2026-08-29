(() => {
  const language = document.documentElement.lang.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const ui = {
    ko: {
      themes: { auto: '테마: 자동', light: '테마: 라이트', dark: '테마: 다크' },
      expandAll: '전체 펼치기',
      collapseAll: '전체 접기',
      progress: (value) => `${value}% 읽음`,
    },
    en: {
      themes: { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' },
      expandAll: 'Expand all',
      collapseAll: 'Collapse all',
      progress: (value) => `${value}% read`,
    },
  }[language];

  const themeButton = document.querySelector('[data-action="toggle-theme"]');
  if (themeButton) {
    const order = ['auto', 'light', 'dark'];
    let theme = 'auto';
    try {
      const stored = localStorage.getItem('make-html-report-theme');
      if (order.includes(stored)) theme = stored;
    } catch { /* Keep automatic mode if storage is unavailable under file://. */ }
    const applyTheme = () => {
      if (theme === 'auto') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
      themeButton.textContent = ui.themes[theme];
    };
    themeButton.addEventListener('click', () => {
      theme = order[(order.indexOf(theme) + 1) % order.length];
      try { localStorage.setItem('make-html-report-theme', theme); } catch { /* The current document still updates. */ }
      applyTheme();
    });
    applyTheme();
  }

  const expandButton = document.querySelector('[data-action="expand-all"]');
  if (expandButton) {
    expandButton.addEventListener('click', () => {
      const details = Array.from(document.querySelectorAll('details.report-chapter, details.code-fold'));
      const shouldOpen = details.some((item) => !item.open);
      details.forEach((item) => { item.open = shouldOpen; });
      expandButton.textContent = shouldOpen ? ui.collapseAll : ui.expandAll;
    });
  }

  const revealLinkedContent = () => {
    if (!window.location.hash) return;
    // Generated section and code IDs are ASCII-only, so decoding is unnecessary and
    // malformed external fragments can be treated as simple misses.
    const target = document.getElementById(window.location.hash.slice(1));
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

  if (window.Prism) window.Prism.highlightAllUnder(document.querySelector('.shell'));

  const minimap = document.querySelector('.minimap');
  const minimapToggle = document.querySelector('[data-action="toggle-minimap"]');
  const minimapLinks = Array.from(document.querySelectorAll('[data-minimap-link]'));
  const sections = Array.from(document.querySelectorAll('[data-report-section]'));

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

  if (minimapLinks.length && sections.length) {
    const updateMinimap = () => {
      const documentHeight = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      const progress = Math.min(100, Math.max(0, Math.round((window.scrollY / documentHeight) * 100)));
      document.querySelectorAll('[data-minimap-progress]').forEach((item) => {
        item.style.width = `${progress}%`;
      });
      document.querySelectorAll('[data-minimap-percent]').forEach((item) => {
        item.textContent = ui.progress(progress);
      });

      const readingLine = window.scrollY + Math.min(window.innerHeight * 0.32, 280);
      let activeIndex = 0;
      sections.forEach((section, sectionIndex) => {
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

    let updateRequested = false;
    const requestUpdate = () => {
      if (updateRequested) return;
      updateRequested = true;
      window.requestAnimationFrame(() => {
        updateMinimap();
        updateRequested = false;
      });
    };
    window.addEventListener('scroll', requestUpdate, { passive: true });
    window.addEventListener('resize', requestUpdate);
    document.querySelectorAll('details').forEach((item) => item.addEventListener('toggle', requestUpdate));
    updateMinimap();
  }
})();
