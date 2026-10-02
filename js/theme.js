/* Tema claro/escuro. Carregado no <head> para aplicar o tema antes de desenhar
   a página (sem piscar). Modos: 'auto' (segue o sistema), 'light' e 'dark'.
   A escolha fica no localStorage deste navegador. */
(function () {
  'use strict';
  const KEY = 'plc-simulator.theme.v1';
  const MODES = ['auto', 'light', 'dark'];

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

  const mode = load();
  apply(mode);

  document.addEventListener('DOMContentLoaded', function () {
    const sel = document.getElementById('sel-theme');
    if (!sel) return;
    sel.value = mode;
    sel.addEventListener('change', function () {
      const m = MODES.includes(sel.value) ? sel.value : 'auto';
      apply(m); save(m);
      sel.blur(); // devolve o teclado aos atalhos (F5, setas…)
    });
  });
})();
