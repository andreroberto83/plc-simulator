/*
 * Editor de Texto Estruturado: textarea sobre uma camada de realce de sintaxe,
 * com números de linha, marcação de erros e coluna de monitoração (valores
 * das variáveis de cada linha durante o RUN). Linhas de comando que não
 * foram executadas no último scan ficam esmaecidas.
 */
(function (root) {
  'use strict';
  const ST = root.PLC.ST;

  const FB_NAMES = new Set(Object.keys(ST.FBS));
  const TYPE_NAMES = new Set(['BOOL', 'SINT', 'INT', 'DINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'TIME', 'ARRAY', 'OF']);
  const FN_RE = /^(ABS|SQRT|MIN|MAX|LIMIT|SEL|MOVE|TRUNC|[A-Z]+_TO_[A-Z]+)$/;
  const INDENT_AFTER = /\b(THEN|ELSE|DO|OF|REPEAT|VAR|VAR\s+CONSTANT)\s*(\(\*.*\*\))?\s*$/i;

  function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  /** Realce de sintaxe tolerante a erros. Retorna um array de linhas em HTML. */
  function highlight(src) {
    const re = /(\(\*[\s\S]*?(?:\*\)|$))|(\/\/[^\n]*)|((?:T|TIME)#[\w.]+)|(%[IQM][XWD]?\d+(?:\.\d+)?)|((?:2|8|16)#[\w]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(:=|=>)/gi;
    let html = '', last = 0, m;
    const wrap = (cls, text) => text.split('\n').map(t => t ? `<span class="${cls}">${esc(t)}</span>` : '').join('\n');
    while ((m = re.exec(src))) {
      html += esc(src.slice(last, m.index));
      const t = m[0];
      if (m[1] || m[2]) html += wrap('c-com', t);
      else if (m[3]) html += wrap('c-time', t);
      else if (m[4]) html += wrap('c-addr', t);
      else if (m[5]) html += wrap('c-num', t);
      else if (m[6]) {
        const up = t.toUpperCase();
        if (up === 'TRUE' || up === 'FALSE') html += wrap('c-num', t);
        else if (ST.KEYWORDS.has(up)) html += wrap(/^(AND|OR|XOR|NOT|MOD)$/.test(up) ? 'c-op' : 'c-kw', t);
        else if (TYPE_NAMES.has(up)) html += wrap('c-type', t);
        else if (FB_NAMES.has(up)) html += wrap('c-fb', t);
        else if (FN_RE.test(up)) html += wrap('c-fn', t);
        else html += esc(t);
      } else html += wrap('c-assign', t);
      last = re.lastIndex;
    }
    html += esc(src.slice(last));
    return html.split('\n');
  }

  class StEditor {
    constructor(host, opts) {
      this.opts = opts || {};
      this.host = host;
      host.innerHTML = `
        <div class="st-wrap">
          <div class="st-scroll">
            <pre class="st-gutter" aria-hidden="true"></pre>
            <div class="st-code">
              <pre class="st-hl" aria-hidden="true"></pre>
              <textarea class="st-ta" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="Código em Texto Estruturado"></textarea>
            </div>
            <div class="st-mon-col">
              <div class="st-mon-grip" role="separator" aria-orientation="vertical"
                   title="Arraste para ajustar a largura da monitoração · duplo clique volta ao padrão"></div>
              <pre class="st-mon" aria-hidden="true"></pre>
            </div>
          </div>
        </div>`;
      this.ta = host.querySelector('.st-ta');
      this.hl = host.querySelector('.st-hl');
      this.gutter = host.querySelector('.st-gutter');
      this.mon = host.querySelector('.st-mon');
      this.bindMonResize();
      this.errors = [];
      this.fault = null;
      this.lineEls = [];
      this.ta.addEventListener('input', () => { this.render(); this.opts.onChange && this.opts.onChange(this.ta.value); });
      this.ta.addEventListener('keydown', e => this.onKey(e));
      this.ta.addEventListener('focus', () => this.opts.onFocus && this.opts.onFocus());
      this.ta.addEventListener('blur', () => this.opts.onBlur && this.opts.onBlur());
    }

    /** Largura da coluna de monitoração ajustável pela alça da esquerda; lembrada no navegador. */
    bindMonResize() {
      const KEY = 'plc-simulator.st-mon.v1';
      const wrap = this.host.querySelector('.st-wrap');
      const grip = this.host.querySelector('.st-mon-grip');
      const setW = w => {
        if (w) wrap.style.setProperty('--st-mon-w', w + 'px');
        else wrap.style.removeProperty('--st-mon-w');
      };
      let width = 0;
      try { width = +localStorage.getItem(KEY) || 0; } catch (e) { /* sem armazenamento */ }
      setW(width);
      const store = () => { try { localStorage.setItem(KEY, String(width || '')); } catch (e) { /* ignora */ } };
      grip.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        grip.classList.add('dragging');
        document.body.classList.add('resizing');
        const move = ev => {
          const r = wrap.getBoundingClientRect();
          width = Math.round(Math.min(Math.max(r.right - ev.clientX, 120), r.width - 220));
          setW(width);
        };
        const up = () => {
          grip.classList.remove('dragging');
          document.body.classList.remove('resizing');
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          store();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
      });
      grip.addEventListener('dblclick', () => { width = 0; setW(0); store(); });
    }

    getText() { return this.ta.value; }
    setText(t) {
      if (this.ta.value !== t) this.ta.value = t;
      this.render();
    }

    render() {
      const src = this.ta.value;
      const lines = highlight(src);
      this.hl.innerHTML = lines.map((l, i) => `<span class="st-line" data-l="${i + 1}">${l || ' '}</span>`).join('\n') + '\n';
      this.lineEls = Array.from(this.hl.querySelectorAll('.st-line'));
      const n = lines.length;
      const maxLen = src.split('\n').reduce((a, l) => Math.max(a, l.length), 0);
      this.ta.style.height = `calc(${n + 1} * var(--st-lh) + 16px)`;
      this.ta.style.width = `calc(${Math.max(maxLen + 4, 40)}ch + 24px)`;
      this.hl.style.width = this.ta.style.width;
      this.renderGutter();
      this.renderMonitor(null);
    }

    renderGutter() {
      const n = this.lineEls.length;
      const errLines = new Set(this.errors.map(e => e.line));
      if (this.fault && this.fault.line) errLines.add(this.fault.line);
      let g = '';
      for (let i = 1; i <= n; i++) g += (errLines.has(i) ? `<span class="g-err">${i}</span>` : String(i)) + '\n';
      this.gutter.innerHTML = g;
      this.lineEls.forEach((el, i) => el.classList.toggle('err', errLines.has(i + 1)));
    }

    setDiagnostics(errors, fault) {
      this.errors = errors || [];
      this.fault = fault || null;
      this.renderGutter();
      if (!this.lastProgram) this.renderMonitor(null);
    }

    /** Coluna da direita: valores em RUN, mensagens de erro em STOP. */
    renderMonitor(program, running) {
      this.lastProgram = running ? program : null;
      const n = this.lineEls.length;
      const rows = new Array(n).fill('');
      if (running && program) {
        for (const k of Object.keys(program.lineRefs)) {
          const li = +k - 1;
          if (li < 0 || li >= n) continue;
          const parts = [];
          for (const ref of program.lineRefs[k].slice(0, 4)) {
            const v = program.watch(ref);
            if (v == null) continue;
            const cls = v === 'TRUE' ? 'm-true' : v === 'FALSE' ? 'm-false' : 'm-val';
            parts.push(`<span class="m-name">${esc(ref)}</span>=<span class="${cls}">${esc(v)}</span>`);
          }
          rows[li] = parts.join('  ');
        }
        const ex = program.executed, all = program.stmtLines;
        this.lineEls.forEach((el, i) => el.classList.toggle('dim', all.has(i + 1) && !ex.has(i + 1)));
      } else {
        this.lineEls.forEach(el => el.classList.remove('dim'));
        for (const e of this.errors) if (e.line >= 1 && e.line <= n && !rows[e.line - 1]) rows[e.line - 1] = `<span class="m-err">⚠ ${esc(e.msg)}</span>`;
      }
      if (this.fault && this.fault.line >= 1 && this.fault.line <= n) rows[this.fault.line - 1] = `<span class="m-err">⛔ ${esc(this.fault.msg)}</span>`;
      const html = rows.join('\n') + '\n';
      if (this.mon.innerHTML !== html) this.mon.innerHTML = html;
    }

    gotoLine(line, col) {
      const lines = this.ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      pos += Math.max(0, (col || 1) - 1);
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos);
      const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 20;
      const sc = this.host.querySelector('.st-scroll');
      sc.scrollTop = Math.max(0, (line - 4) * lh);
    }

    /** Insere texto no cursor, mantendo a indentação da linha atual. */
    insert(text) {
      const ta = this.ta;
      const start = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, start))[0];
      const atLineStart = ta.value.slice(lineStart, start).trim() === '';
      let t = text.replace(/\n/g, '\n' + indent);
      if (!atLineStart) t = '\n' + indent + t;
      const lineEnd = ta.value.indexOf('\n', ta.selectionEnd);
      const rest = ta.value.slice(ta.selectionEnd, lineEnd < 0 ? undefined : lineEnd);
      if (rest.trim()) t += '\n' + indent;
      const caret = t.indexOf('§');
      t = t.replace('§', '');
      ta.focus();
      ta.setRangeText(t, start, ta.selectionEnd, 'end');
      if (caret >= 0) {
        // seleciona o nome provisório (ex.: "condicao") para ser substituído ao digitar
        const word = /^[A-Za-z_]\w*/.exec(t.slice(caret));
        ta.setSelectionRange(start + caret, start + caret + (word ? word[0].length : 0));
      }
      ta.dispatchEvent(new Event('input'));
    }

    onKey(e) {
      const ta = this.ta;
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const v = ta.value;
        if (s !== en && v.slice(s, en).includes('\n') || e.shiftKey) {
          const ls = v.lastIndexOf('\n', s - 1) + 1;
          const block = v.slice(ls, en);
          const nb = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
          ta.setRangeText(nb, ls, en, 'select');
        } else ta.setRangeText('  ', s, en, 'end');
        ta.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const s = ta.selectionStart;
        const v = ta.value;
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const cur = v.slice(ls, s);
        let indent = /^[ \t]*/.exec(cur)[0];
        if (INDENT_AFTER.test(cur)) indent += '  ';
        ta.setRangeText('\n' + indent, s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    }
  }

  root.PLC = root.PLC || {};
  root.PLC.StEditor = StEditor;
  root.PLC.StEditor.highlight = highlight;
})(typeof window !== 'undefined' ? window : globalThis);
