// Run before stylesheets so the saved theme is applied before the first paint.
(() => {
  const key = 'studio.theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => value === 'light' || value === 'dark';
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Private storage may be unavailable. */ }
  if (!valid(preference)) preference = null;
  function apply() {
    const theme = preference || (system.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f5f7fb');
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(theme === 'dark'));
      toggle.title = theme === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему';
      toggle.setAttribute('aria-label', toggle.title);
      document.getElementById('theme-label').textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
    }
    document.dispatchEvent(new CustomEvent('studio-theme-change', { detail: theme }));
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Still switch for this session. */ }
      apply();
    });
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : null;
    apply();
  });
})();
