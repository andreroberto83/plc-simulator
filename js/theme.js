/* Tema claro/escuro. Carregado no <head> para aplicar o tema antes de desenhar
   a página (sem piscar). Modos: 'auto' (segue o sistema), 'light' e 'dark'.
   A escolha fica no localStorage deste navegador. */
(function () {
  'use strict';
  const KEY = 'plc-simulator.theme.v1';
  const MODES = ['auto', 'light', 'dark'];
  const INFO = {
    auto:  { icon: '◐', label: 'Automático (segue o sistema)' },
    light: { icon: '☀', label: 'Claro' },
    dark:  { icon: '☾', label: 'Escuro' },
  };

  function load() {
    try { const m = localStorage.getItem(KEY); return MODES.includes(m) ? m : 'auto'; }
    catch (e) { return 'auto'; }
  }
  function save(mode) {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* navegador sem armazenamento: só não lembra */ }
  }
  function apply(mode) {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  let mode = load();
  apply(mode);

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('btn-theme');
    if (!btn) return;
    function show() {
      btn.textContent = INFO[mode].icon;
      btn.title = 'Tema: ' + INFO[mode].label + ' — clique para trocar';
      btn.setAttribute('aria-label', btn.title);
    }
    btn.addEventListener('click', function () {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      apply(mode); save(mode); show();
    });
    show();
  });
})();
