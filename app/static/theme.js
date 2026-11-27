'use strict';
(function () {
  const KEY = 'lab-note-theme';
  const root = document.documentElement;

  function readTheme() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (_) {}
    return 'light';
  }

  function syncButton(mode) {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const isDark = mode === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    btn.textContent = isDark ? '☀️ 浅色' : '🌙 深色';
    btn.title = isDark ? '切换到浅色模式' : '切换到深色模式';
  }

  function applyTheme(mode, persist = false) {
    const next = mode === 'dark' ? 'dark' : 'light';
    root.dataset.theme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#161d1a' : '#285b46');
    if (persist) {
      try { localStorage.setItem(KEY, next); } catch (_) {}
    }
    syncButton(next);
    return next;
  }

  function toggleTheme() {
    return applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark', true);
  }

  // Apply before first paint to avoid flash of light background.
  applyTheme(readTheme(), false);

  function bindToggle() {
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      syncButton(root.dataset.theme || 'light');
      btn.onclick = () => toggleTheme();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindToggle);
  else bindToggle();

  window.labTheme = { apply: applyTheme, toggle: toggleTheme, current: () => root.dataset.theme || 'light' };
})();
