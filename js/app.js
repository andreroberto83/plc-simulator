/*
 * Aplicação: liga editor, motor de execução e cenas.
 */
(function () {
  'use strict';
  const { Addr, Model, Engine, LadderView, Scenes, Examples, ST, StEditor, StExamples } = window.PLC;

  const STORAGE_KEY = 'plc-simulator.project.v1';
  const COND_TYPES = ['NO', 'NC', 'P', 'N', 'CMP'];
  const OUT_TYPES = ['COIL', 'COILN', 'SET', 'RST', 'TON', 'TOF', 'TP', 'CTU', 'CTD', 'RES'];

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    project: null,
    sel: null,            // { rungId, id }  (id null = degrau inteiro)
    mode: 'series',
    undo: [], redo: [],
    engine: new Engine(),
    scene: null, sceneInstance: null,
    tab: 'props',
    lastRender: 0,
    stEditor: null,
    stSnapshot: null,     // projeto antes de começar a digitar (para o desfazer da aplicação)
    lastFault: null,
  };
  const isST = () => state.project && state.project.language === 'ST';

  // ================================================================ projeto
  function loadProject(p, keepHistory) {
    state.project = p;
    state.engine.stop();
    state.engine.setProject(p);
    if (!keepHistory) { state.undo = []; state.redo = []; }
    state.sel = p.rungs.length ? { rungId: p.rungs[0].id, id: null } : null;
    state.lastFault = null;
    $('#project-name').value = p.name;
    $('#sel-scan').value = String(p.scanMs);
    if (!$('#sel-scan').value) $('#sel-scan').value = '50';
    mountScene(p.sceneId, false);
    applyLanguageUi();
    if (isST()) state.stEditor.setText(p.st || '');
    state.engine.compile();
    refreshAll();
    updateRunUi();
  }

  /** Toda mudança no programa passa por aqui: guarda histórico, recompila, redesenha. */
  function commit(mutator) {
    state.undo.push(JSON.stringify(state.project));
    if (state.undo.length > 150) state.undo.shift();
    state.redo = [];
    mutator();
    changed();
  }
  function changed() {
    state.engine.markDirty();
    state.engine.compile();
    refreshAll();
    autosave();
  }

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.project));
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.project));
    restore(state.redo.pop());
  }
  function restore(json) {
    const running = state.engine.running;
    const p = JSON.parse(json);
    state.project = p;
    state.engine.setProject(p);
    if (!running) state.engine.stop();
    if (state.sel && state.sel.id && !Model.locate(p, state.sel.id)) state.sel = { rungId: state.sel.rungId, id: null };
    if (state.sel && !p.rungs.find(r => r.id === state.sel.rungId)) state.sel = p.rungs[0] ? { rungId: p.rungs[0].id, id: null } : null;
    $('#project-name').value = p.name;
    applyLanguageUi();
    changed();
  }

  let saveTimer = null;
  function autosave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.project)); } catch (e) { /* armazenamento indisponível */ }
    }, 400);
  }
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Model.validateProject(JSON.parse(raw));
    } catch (e) { /* ignora */ }
    return null;
  }

  function saveFile() {
    const p = state.project;
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (p.name || 'projeto').replace(/[^\w\-. ]+/g, '_') + '.plc.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Arquivo salvo em Downloads');
  }
  function openFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const p = Model.validateProject(JSON.parse(rd.result));
        loadProject(p);
        autosave();
        toast('Projeto aberto: ' + p.name);
      } catch (e) { toast('Não foi possível abrir: ' + e.message, true); }
    };
    rd.readAsText(file);
  }

  // ================================================================ cenas
  function mountScene(id, mergeSymbols) {
    if (state.sceneInstance && state.sceneInstance.destroy) state.sceneInstance.destroy();
    const scene = Scenes.get(id);
    state.scene = scene;
    state.project.sceneId = scene.id;
    const host = $('#scene-host');
    host.innerHTML = '';
    state.engine.physIn = {};
    state.sceneInstance = scene.create(host, {
      setInput: (k, v) => state.engine.setInput(k, v),
      getOutput: k => state.engine.getOutput(k),
    });
    $('#sel-scene').value = scene.id;
    $('#scene-desc').innerHTML = scene.description;
    if (mergeSymbols) {
      let added = 0;
      for (const [addr, name, comment] of scene.io.inputs.concat(scene.io.outputs)) {
        const cur = state.project.symbols[addr];
        if (!cur || !cur.name) { state.project.symbols[addr] = { name, comment }; added++; }
      }
      if (added) state.engine.markDirty();
    }
  }

  // ================================================================ editor
  function renderEditor() {
    if (isST()) { renderStMonitor(); return; }
    const eng = state.engine;
    const errs = {};
    if (eng.compiled) eng.compiled.errors.forEach(e => { errs[e.id] = e.msg; });
    const ctx = {
      power: eng.power, rungPower: eng.rungPower, running: eng.running, engine: eng,
      selectedId: state.sel && state.sel.id, errors: errs, symbols: state.project.symbols,
      cols: LadderView.columnsFor(state.project),
    };
    const html = state.project.rungs.map((rung, i) => {
      const selRung = state.sel && state.sel.rungId === rung.id;
      return `<div class="rung${selRung ? ' sel' : ''}${selRung && !state.sel.id ? ' sel-whole' : ''}" data-rung="${rung.id}">
        <div class="rung-head"><span class="rung-num">${String(i + 1).padStart(3, '0')}</span><span class="rung-comment">${esc(rung.comment)}</span></div>
        <div class="rung-body">${LadderView.renderRung(rung, ctx)}</div>
      </div>`;
    }).join('');
    const ed = $('#editor');
    const scroll = ed.scrollTop, scrollL = ed.scrollLeft;
    ed.innerHTML = html + `<div class="end-rung">(END)</div>`;
    ed.scrollTop = scroll; ed.scrollLeft = scrollL;
  }

  function onEditorClick(e) {
    const g = e.target.closest('[data-id]');
    const rungEl = e.target.closest('[data-rung]');
    if (!rungEl) return;
    const rungId = rungEl.getAttribute('data-rung');
    state.sel = { rungId, id: g ? g.getAttribute('data-id') : null };
    if (state.tab !== 'props') showTab('props');
    renderEditor();
    renderProps();
  }
  function onEditorDblClick(e) {
    if (!e.target.closest('[data-id]')) return;
    const first = $('#tab-props input[data-field], #tab-props select[data-field]');
    if (first) { first.focus(); first.select && first.select(); }
  }

  function insert(type) {
    const el = Model.createInstr(type);
    guessOperand(el);
    commit(() => {
      if (!state.project.rungs.length) state.project.rungs.push(Model.newRung());
      if (Model.INSTR[type].cond) Model.insertCondition(state.project, state.sel, el, state.mode);
      else Model.insertOutput(state.project, state.sel, el);
      const loc = Model.locate(state.project, el.id);
      state.sel = { rungId: loc.rung.id, id: el.id };
    });
    const f = $('#tab-props input[data-field]');
    if (f) { f.focus(); f.select(); }
  }

  /** Sugere um operando livre para agilizar a digitação. */
  function guessOperand(el) {
    const used = new Set();
    Model.forEachInstr(state.project, x => {
      if (x.op) used.add(String(x.op).toUpperCase());
    });
    const free = (prefix, n) => { for (let i = 0; i < n; i++) if (!used.has(prefix + i)) return prefix + i; return prefix + '0'; };
    if (['TON', 'TOF', 'TP'].includes(el.type)) el.op = free('T', 32);
    if (['CTU', 'CTD'].includes(el.type)) el.op = free('C', 32);
  }

  function deleteSelection() {
    const s = state.sel;
    if (!s) return;
    if (s.id) {
      commit(() => { Model.removeElement(state.project, s.id); state.sel = { rungId: s.rungId, id: null }; });
    } else {
      const idx = state.project.rungs.findIndex(r => r.id === s.rungId);
      if (idx < 0) return;
      commit(() => {
        state.project.rungs.splice(idx, 1);
        const next = state.project.rungs[Math.min(idx, state.project.rungs.length - 1)];
        state.sel = next ? { rungId: next.id, id: null } : null;
      });
    }
  }

  function addRung() {
    const r = Model.newRung();
    commit(() => {
      const idx = state.sel ? state.project.rungs.findIndex(x => x.id === state.sel.rungId) : -1;
      state.project.rungs.splice(idx + 1, 0, r);
      state.sel = { rungId: r.id, id: null };
    });
  }

  function moveRung(delta) {
    const i = state.project.rungs.findIndex(r => r.id === state.sel.rungId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.project.rungs.length) return;
    commit(() => { const rs = state.project.rungs; [rs[i], rs[j]] = [rs[j], rs[i]]; });
  }

  function duplicateRung() {
    const i = state.project.rungs.findIndex(r => r.id === state.sel.rungId);
    if (i < 0) return;
    const copy = Model.clone(state.project.rungs[i]);
    Model.reId(copy);
    commit(() => { state.project.rungs.splice(i + 1, 0, copy); state.sel = { rungId: copy.id, id: null }; });
  }

  // ================================================================ propriedades
  function renderProps() {
    if (isST()) { renderStReference(); return; }
    const box = $('#tab-props');
    const s = state.sel;
    const p = state.project;
    if (!s) { box.innerHTML = '<p class="muted">Clique num degrau ou numa instrução.</p>'; return; }
    const errs = state.engine.compiled ? state.engine.compiled.errors : [];

    if (s.id) {
      const loc = Model.locate(p, s.id);
      if (!loc) { box.innerHTML = ''; return; }
      const el = loc.where === 'output' ? loc.parent[loc.index] : loc.parent.items[loc.index];
      const info = Model.INSTR[el.type];
      const err = errs.find(e => e.id === el.id);
      const fields = [];
      const opList = 'dl-ops';
      if (el.type === 'CMP') {
        fields.push(field('Operando A', `<input data-field="a" list="${opList}" value="${esc(el.a)}" spellcheck="false">`));
        fields.push(field('Operador', `<select data-field="cmp">${Model.CMP_OPS.map(o => `<option${o === el.cmp ? ' selected' : ''}>${o}</option>`).join('')}</select>`));
        fields.push(field('Operando B', `<input data-field="b" list="${opList}" value="${esc(el.b)}" spellcheck="false">`));
        fields.push('<p class="hint">Palavras: IW0, MW0, T0.ACC, C0.PRE… ou um número.</p>');
      } else {
        const ph = { TON: 'T0', TOF: 'T0', TP: 'T0', CTU: 'C0', CTD: 'C0', RES: 'T0 ou C0' }[el.type] || 'I0.0, Q0.0, M0.0, T0.DN…';
        fields.push(field('Operando', `<input data-field="op" list="${opList}" value="${esc(el.op)}" placeholder="${ph}" spellcheck="false">`));
        const resolved = Addr.resolve(el.op, p.symbols);
        if (resolved) {
          const sym = Addr.symbolOf(resolved.key, p.symbols);
          const cm = p.symbols[resolved.key] && p.symbols[resolved.key].comment;
          fields.push(`<p class="hint">${esc(resolved.key)}${sym ? ' = ' + esc(sym) : ''}${cm ? ' — ' + esc(cm) : ''}</p>`);
        }
      }
      if (['TON', 'TOF', 'TP'].includes(el.type)) {
        fields.push(field('Preset (ms)', `<input data-field="pre" type="number" min="0" step="100" value="${esc(el.pre)}">`));
        fields.push(`<p class="hint">${esc(Number(el.pre) / 1000)} s. Bits: ${esc(el.op)}.EN, .TT (temporizando), .DN (concluído). Valor: .ACC</p>`);
      }
      if (['CTU', 'CTD'].includes(el.type)) {
        fields.push(field('Preset', `<input data-field="pre" type="number" step="1" value="${esc(el.pre)}">`));
        fields.push(`<p class="hint">Bits: ${esc(el.op)}.DN (ACC ≥ PRE), .CU, .CD. Valor: .ACC</p>`);
      }
      box.innerHTML = `
        <div class="props-head"><strong>${esc(info.label)}</strong><span class="muted"> · degrau ${loc.rungIndex + 1}</span></div>
        <p class="hint">${esc(info.hint)}</p>
        ${fields.join('')}
        ${err ? `<p class="error">⚠ ${esc(err.msg)}</p>` : ''}
        <div class="props-actions">
          <button type="button" class="btn" data-act="left" title="Mover para a esquerda / cima">◀</button>
          <button type="button" class="btn" data-act="right" title="Mover para a direita / baixo">▶</button>
          <button type="button" class="btn danger" data-act="del">Excluir</button>
        </div>
        ${datalist(opList)}`;
    } else {
      const idx = p.rungs.findIndex(r => r.id === s.rungId);
      const rung = p.rungs[idx];
      if (!rung) { box.innerHTML = ''; return; }
      box.innerHTML = `
        <div class="props-head"><strong>Degrau ${idx + 1}</strong></div>
        ${field('Comentário', `<textarea data-field="comment" rows="3">${esc(rung.comment)}</textarea>`)}
        <p class="hint">Com o degrau selecionado, os contatos são inseridos no fim da lógica e as saídas no fim da lista.
        No modo <b>Paralelo</b>, o novo contato fica em paralelo com toda a lógica do degrau.</p>
        <div class="props-actions">
          <button type="button" class="btn" data-act="rung-up">▲ Subir</button>
          <button type="button" class="btn" data-act="rung-down">▼ Descer</button>
          <button type="button" class="btn" data-act="rung-dup">Duplicar</button>
          <button type="button" class="btn danger" data-act="del">Excluir degrau</button>
        </div>`;
    }
  }

  function field(label, control) { return `<label class="field"><span>${esc(label)}</span>${control}</label>`; }

  function datalist(id) {
    const p = state.project;
    const opts = new Set();
    Object.keys(p.symbols).forEach(a => { const n = p.symbols[a].name; if (n) opts.add(`<option value="${esc(n)}">${esc(a)}</option>`); });
    tagAddresses().forEach(a => opts.add(`<option value="${esc(a)}"></option>`));
    return `<datalist id="${id}">${Array.from(opts).join('')}</datalist>`;
  }

  function onPropsChange(e) {
    const f = e.target.getAttribute('data-field');
    if (!f || !state.sel) return;
    const value = e.target.value;
    if (state.sel.id) {
      const loc = Model.locate(state.project, state.sel.id);
      if (!loc) return;
      const el = loc.where === 'output' ? loc.parent[loc.index] : loc.parent.items[loc.index];
      commit(() => { el[f] = f === 'pre' ? Number(value) : value.trim(); });
    } else {
      const rung = state.project.rungs.find(r => r.id === state.sel.rungId);
      if (rung) commit(() => { rung[f] = value; });
    }
  }

  function onPropsClick(e) {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.getAttribute('data-act');
    if (a === 'del') deleteSelection();
    else if (a === 'left' || a === 'right') commit(() => Model.moveElement(state.project, state.sel.id, a === 'left' ? -1 : 1));
    else if (a === 'rung-up') moveRung(-1);
    else if (a === 'rung-down') moveRung(1);
    else if (a === 'rung-dup') duplicateRung();
  }

  // ================================================================ tags
  function tagAddresses() {
    const p = state.project;
    const set = new Set();
    if (state.scene) state.scene.io.inputs.concat(state.scene.io.outputs).forEach(([a]) => set.add(a));
    Object.keys(p.symbols).forEach(a => set.add(a));
    Model.forEachInstr(p, el => {
      [el.op, el.a, el.b].forEach(t => {
        const r = t != null && Addr.resolve(String(t), p.symbols);
        if (r) set.add(r.kind === 'timer' || r.kind === 'counter' ? r.base : r.key);
      });
    });
    const order = k => { const m = /^([A-Z]+)(\d+)(?:\.(\d))?/.exec(k) || []; return ['I', 'IW', 'Q', 'QW', 'M', 'MW', 'T', 'C'].indexOf(m[1]) * 1e6 + (+m[2] || 0) * 10 + (+m[3] || 0); };
    return Array.from(set).filter(a => Addr.parse(a)).sort((a, b) => order(a) - order(b));
  }

  function renderTags() {
    if (isST()) { renderStVars(); return; }
    const p = state.project;
    const rows = tagAddresses().map(a => {
      const s = p.symbols[a] || {};
      return `<tr data-addr="${esc(a)}">
        <td class="mono">${esc(Addr.iec(a))}</td>
        <td><input data-sym="name" value="${esc(s.name || '')}" spellcheck="false"></td>
        <td><input data-sym="comment" value="${esc(s.comment || '')}"></td>
        <td class="mono val" data-val="${esc(a)}"></td>
      </tr>`;
    }).join('');
    $('#tab-tags').innerHTML = `
      <table class="tags">
        <thead><tr><th>Endereço</th><th>Símbolo</th><th>Comentário</th><th>Valor</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="add-tag">
        <input id="new-tag" placeholder="Novo endereço (ex.: M0.3, T5)" spellcheck="false">
        <button type="button" class="btn" id="btn-add-tag">Adicionar</button>
      </div>
      <p class="hint">Símbolos podem ser usados no lugar do endereço nas instruções. Para temporizadores e contadores, use o símbolo com sufixo: <span class="mono">Atraso.DN</span>.</p>`;
    updateTagValues();
  }

  function updateTagValues() {
    if (state.tab !== 'tags') return;
    if (isST()) { updateStVarValues(); return; }
    const eng = state.engine;
    $$('#tab-tags [data-val]').forEach(td => {
      const a = td.getAttribute('data-val');
      let v = '';
      if (eng.running) {
        const x = eng.peek(a);
        if (x && typeof x === 'object') v = `ACC ${x.ACC} · DN ${x.DN}`;
        else if (x !== undefined) v = String(x);
      } else {
        const p = Addr.parse(a);
        if (p && (p.area === 'I' || p.area === 'IW')) v = String(eng.physIn[a] != null ? +eng.physIn[a] : '');
      }
      if (td.textContent !== v) td.textContent = v;
      td.classList.toggle('on', v === '1');
    });
  }

  function onTagsChange(e) {
    const kind = e.target.getAttribute('data-sym');
    if (!kind) return;
    const addr = e.target.closest('tr').getAttribute('data-addr');
    const value = e.target.value.trim();
    if (kind === 'name' && value) {
      if (Addr.parse(value)) { toast('O símbolo não pode ter formato de endereço', true); e.target.value = (state.project.symbols[addr] || {}).name || ''; return; }
      const dup = Object.keys(state.project.symbols).find(k => k !== addr && (state.project.symbols[k].name || '').toLowerCase() === value.toLowerCase());
      if (dup) { toast(`Símbolo já usado em ${dup}`, true); e.target.value = (state.project.symbols[addr] || {}).name || ''; return; }
      if (!/^[A-Za-z_][\w]*$/.test(value)) { toast('Use letras, números e _ (sem espaços)', true); return; }
    }
    commit(() => {
      const s = state.project.symbols[addr] || (state.project.symbols[addr] = {});
      s[kind] = value;
      if (!s.name && !s.comment) delete state.project.symbols[addr];
    });
  }

  function addTag() {
    const inp = $('#new-tag');
    const p = Addr.parse(inp.value);
    if (!p || (p.field && (p.kind === 'timer' || p.kind === 'counter'))) { toast('Endereço inválido', true); return; }
    const key = p.kind === 'timer' || p.kind === 'counter' ? p.base : p.key;
    commit(() => { state.project.symbols[key] = state.project.symbols[key] || { name: '', comment: '' }; });
  }

  // ================================================================ diagnóstico
  function renderDiag() {
    const c = state.engine.compiled || { errors: [], warnings: [] };
    const f = state.engine.fault;
    const badge = $('#diag-badge');
    const n = c.errors.length + c.warnings.length + (f ? 1 : 0);
    badge.hidden = !n;
    badge.textContent = n;
    badge.classList.toggle('warn', !c.errors.length && !f);
    const where = e => e.line ? `<b>Linha ${e.line}:</b> ` : (e.rungIndex >= 0 ? `<b>Degrau ${e.rungIndex + 1}:</b> ` : '');
    const item = (e, kind) => `<li class="${kind}" ${e.id ? `data-goto="${e.id}"` : ''} ${e.line ? `data-line="${e.line}" data-col="${e.col || 1}"` : ''}>${kind === 'error' ? '⚠' : 'ℹ'} ${where(e)}${esc(e.msg)}</li>`;
    const faultHtml = f ? `<ul class="diag"><li class="error" ${f.line ? `data-line="${f.line}"` : ''}>⛔ <b>Falha em execução${f.line ? ` (linha ${f.line})` : ''}:</b> ${esc(f.msg)}</li></ul>` : '';
    $('#tab-diag').innerHTML = faultHtml + (!n
      ? '<p class="ok">Nenhum problema encontrado.</p>'
      : `<ul class="diag">${c.errors.map(e => item(e, 'error')).join('')}${c.warnings.map(w => item(w, 'warning')).join('')}</ul>`);
  }

  // ================================================================ RUN/STOP
  function toggleRun() {
    const eng = state.engine;
    if (eng.running) {
      eng.stop();
      $('#scan-count').textContent = '';
    } else {
      eng.markDirty();
      const c = eng.compile();
      if (c.errors.length) {
        renderDiag(); showTab('diag');
        toast(`O programa tem ${c.errors.length} erro(s). Corrija antes de colocar em RUN.`, true);
        return;
      }
      state.lastFault = null;
      if (!eng.start()) {
        toast(eng.fault ? 'Falha ao iniciar: ' + eng.fault.msg : 'Não foi possível entrar em RUN', true);
        renderDiag(); syncStDiagnostics();
        return;
      }
      acc = 0;
      syncStDiagnostics();
    }
    updateRunUi();
    renderEditor();
  }
  function updateRunUi() {
    const r = state.engine.running;
    const b = $('#btn-run');
    b.textContent = r ? '■ STOP' : '▶ RUN';
    b.classList.toggle('running', r);
    const st = $('#plc-status');
    st.textContent = r ? 'RUN' : 'STOP';
    st.className = 'plc-status ' + (r ? 'run' : 'stop');
    document.body.classList.toggle('is-running', r);
  }

  // ================================================================ laço principal
  /*
   * O scan e a física da cena rodam num "relógio" de Web Worker: o navegador
   * reduz timers e para o requestAnimationFrame quando a aba fica oculta, e o
   * CLP não pode parar só porque o professor trocou de janela para o Node-RED.
   * O redesenho do editor continua no requestAnimationFrame.
   */
  let last = performance.now(), acc = 0;
  function tick() {
    const now = performance.now();
    const dt = Math.min(250, now - last);
    last = now;
    const eng = state.engine;
    if (eng.running) {
      const period = state.project.scanMs;
      acc += dt;
      let n = 0;
      while (acc >= period && n < 20) { eng.scan(period); acc -= period; n++; }
      if (n === 20) acc = 0;
    }
    if (state.sceneInstance) state.sceneInstance.step(dt);
  }

  function startClock() {
    try {
      const src = 'let t=null;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data);};';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = tick;
      w.postMessage(10);
    } catch (e) {
      setInterval(tick, 10);   // sem Worker: funciona, mas desacelera com a aba oculta
    }
  }

  function frame(now) {
    const eng = state.engine;
    if (eng.running) {
      if (now - state.lastRender > 80) {
        state.lastRender = now;
        renderEditor();
        updateTagValues();
        $('#scan-count').textContent = `scans: ${eng.scanCount}`;
      }
    } else if (now - state.lastRender > 300) {
      state.lastRender = now;
      updateTagValues();
    }
    if (eng.fault && eng.fault !== state.lastFault) {
      state.lastFault = eng.fault;
      updateRunUi();
      renderDiag();
      syncStDiagnostics();
      renderEditor();
      toast('Falha em execução: ' + eng.fault.msg, true);
    }
    if (window.PLC.Comm) window.PLC.Comm.render();
    requestAnimationFrame(frame);
  }

  // ================================================================ UI geral
  function showTab(name) {
    state.tab = name;
    $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.getAttribute('data-tab') === name));
    $$('.tab-body').forEach(b => { b.hidden = b.getAttribute('data-tab') !== name; });
    if (name === 'tags') renderTags();
    if (name === 'diag') renderDiag();
    if (name === 'props') renderProps();
  }

  function refreshAll() {
    if (isST()) {
      state.stEditor.setText(state.project.st || '');
      syncStDiagnostics();
    }
    renderEditor();
    renderProps();
    renderDiag();
    if (state.tab === 'tags') renderTags();
    $('#btn-undo').disabled = !state.undo.length;
    $('#btn-redo').disabled = !state.redo.length;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2500);
  }

  function buildPalette() {
    const mk = (type, parent) => {
      const info = Model.INSTR[type];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-btn instr';
      b.title = `${info.label} — ${info.hint}`;
      b.innerHTML = paletteIcon(type);
      b.addEventListener('click', () => insert(type));
      parent.appendChild(b);
    };
    COND_TYPES.forEach(t => mk(t, $('#pal-cond')));
    OUT_TYPES.forEach(t => mk(t, $('#pal-out')));
  }

  function paletteIcon(type) {
    const w = 'stroke="currentColor" stroke-width="2" fill="none"';
    const contact = extra => `<svg viewBox="0 0 40 20" width="40" height="20"><path d="M0 10H14M26 10H40M14 2V18M26 2V18" ${w}/>${extra || ''}</svg>`;
    const coil = letter => `<svg viewBox="0 0 40 20" width="40" height="20"><path d="M0 10H12M28 10H40M16 2Q10 10 16 18M24 2Q30 10 24 18" ${w}/>${letter ? `<text x="20" y="14" font-size="10" text-anchor="middle" fill="currentColor" font-weight="700">${letter}</text>` : ''}</svg>`;
    switch (type) {
      case 'NO': return contact() + '<span>NA</span>';
      case 'NC': return contact(`<path d="M12 17L28 3" ${w}/>`) + '<span>NF</span>';
      case 'P': return contact('<text x="20" y="14" font-size="10" text-anchor="middle" fill="currentColor" font-weight="700">P</text>') + '<span>Borda ↑</span>';
      case 'N': return contact('<text x="20" y="14" font-size="10" text-anchor="middle" fill="currentColor" font-weight="700">N</text>') + '<span>Borda ↓</span>';
      case 'CMP': return '<svg viewBox="0 0 40 20" width="40" height="20"><rect x="6" y="2" width="28" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><text x="20" y="14" font-size="10" text-anchor="middle" fill="currentColor">≥</text></svg><span>Comparar</span>';
      case 'COIL': return coil('') + '<span>Bobina</span>';
      case 'COILN': return coil('/') + '<span>Negada</span>';
      case 'SET': return coil('S') + '<span>Set</span>';
      case 'RST': return coil('R') + '<span>Reset</span>';
      case 'RES': return '<svg viewBox="0 0 40 20" width="40" height="20"><text x="20" y="15" font-size="11" text-anchor="middle" fill="currentColor" font-weight="700">RES</text></svg><span>Zera T/C</span>';
      default: return `<svg viewBox="0 0 40 20" width="40" height="20"><rect x="4" y="2" width="32" height="16" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><text x="20" y="14" font-size="9" text-anchor="middle" fill="currentColor" font-weight="700">${type}</text></svg><span>${{ TON: 'Atraso lig.', TOF: 'Atraso desl.', TP: 'Pulso', CTU: 'Conta ↑', CTD: 'Conta ↓' }[type]}</span>`;
    }
  }

  function bindUi() {
    buildPalette();
    Scenes.list().forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; $('#sel-scene').appendChild(o); });
    const group = (label, list) => {
      const g = document.createElement('optgroup'); g.label = label;
      list.forEach(ex => { const o = document.createElement('option'); o.value = ex.id; o.textContent = ex.name; g.appendChild(o); });
      $('#sel-example').appendChild(g);
    };
    group('Texto Estruturado (ST)', StExamples.EXAMPLES);
    group('Ladder (LD)', Examples);

    // pointerdown (e não click): em RUN o SVG é redesenhado a cada ~80 ms e o click se perderia
    $('#editor').addEventListener('pointerdown', onEditorClick);
    $('#editor').addEventListener('dblclick', onEditorDblClick);
    $('#tab-props').addEventListener('change', onPropsChange);
    $('#tab-props').addEventListener('click', onPropsClick);
    $('#tab-props').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    $('#tab-tags').addEventListener('change', onTagsChange);
    $('#tab-tags').addEventListener('click', e => { if (e.target.id === 'btn-add-tag') addTag(); });
    $('#tab-tags').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'new-tag') addTag(); else if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur(); });
    $('#tab-diag').addEventListener('click', e => {
      const ln = e.target.closest('[data-line]');
      if (ln && isST()) { state.stEditor.gotoLine(+ln.getAttribute('data-line'), +(ln.getAttribute('data-col') || 1)); return; }
      const li = e.target.closest('[data-goto]');
      if (!li) return;
      const loc = Model.locate(state.project, li.getAttribute('data-goto'));
      if (!loc) return;
      state.sel = { rungId: loc.rung.id, id: li.getAttribute('data-goto') };
      showTab('props'); renderEditor();
      const g = document.querySelector(`[data-id="${li.getAttribute('data-goto')}"]`);
      if (g) g.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    });
    $$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.getAttribute('data-tab'))));
    $$('.seg [data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.getAttribute('data-mode'))));

    bindSt();
    $('#btn-add-rung').addEventListener('click', addRung);
    $('#btn-del').addEventListener('click', deleteSelection);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-run').addEventListener('click', toggleRun);
    $('#btn-save').addEventListener('click', saveFile);
    $('#btn-open').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', e => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
    $('#btn-new').addEventListener('click', () => {
      if (!confirmDiscard()) return;
      const p = Model.newProject();
      p.sceneId = state.scene ? state.scene.id : 'painel';
      if (isST()) { p.language = 'ST'; p.st = StExamples.template(p.sceneId); p.rungs = []; }
      loadProject(p);
      mountScene(p.sceneId, true);
      changed();
    });
    $('#sel-example').addEventListener('change', e => {
      const ex = StExamples.EXAMPLES.concat(Examples).find(x => x.id === e.target.value);
      e.target.value = '';
      if (!ex || !confirmDiscard()) return;
      loadProject(ex.build());
      autosave();
      toast('Exemplo carregado: ' + ex.name);
    });
    $('#sel-scene').addEventListener('change', e => {
      commit(() => mountScene(e.target.value, true));
    });
    $('#btn-scene-info').addEventListener('click', () => { const d = $('#scene-desc'); d.hidden = !d.hidden; });
    $('#sel-scan').addEventListener('change', e => { const v = Number(e.target.value); commit(() => { state.project.scanMs = v; }); });
    $('#project-name').addEventListener('change', e => { const v = e.target.value.trim() || 'Projeto'; commit(() => { state.project.name = v; }); });

    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); return; }
      if (e.key === 'F5') { e.preventDefault(); toggleRun(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (isST()) return;
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
      else if (e.key === 'Escape' && state.sel) { state.sel = { rungId: state.sel.rungId, id: null }; renderEditor(); renderProps(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = state.sel ? state.project.rungs.findIndex(r => r.id === state.sel.rungId) : -1;
        const j = Math.max(0, Math.min(state.project.rungs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        if (state.project.rungs[j]) { e.preventDefault(); state.sel = { rungId: state.project.rungs[j].id, id: null }; renderEditor(); renderProps(); }
      }
    });
  }

  function setMode(m) {
    state.mode = m;
    $$('.seg [data-mode]').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === m));
  }

  function confirmDiscard() {
    return state.undo.length === 0 || window.confirm('Descartar o programa atual? (Salve antes se quiser mantê-lo.)');
  }

  // ================================================================ Texto Estruturado
  function applyLanguageUi() {
    const st = isST();
    $$('.lang-seg [data-lang]').forEach(b => b.classList.toggle('on', b.getAttribute('data-lang') === (st ? 'ST' : 'LD')));
    $('#palette').hidden = st;
    $('#st-palette').hidden = !st;
    $('#editor').hidden = st;
    $('#st-host').hidden = !st;
    $('#tab-btn-props').textContent = st ? 'Referência' : 'Propriedades';
    $('#tab-btn-tags').textContent = st ? 'Variáveis' : 'Tags';
    document.title = (st ? 'ST' : 'Ladder') + ' — Simulador de CLP';
  }

  function setLanguage(lang) {
    if ((lang === 'ST') === isST()) return;
    if (state.engine.running) toggleRun();
    commit(() => {
      state.project.language = lang;
      if (lang === 'ST' && !(state.project.st || '').trim()) state.project.st = StExamples.template(state.project.sceneId);
      if (lang === 'LD' && !state.project.rungs.length) state.project.rungs.push(Model.newRung());
    });
    if (lang === 'LD' && !state.sel && state.project.rungs[0]) state.sel = { rungId: state.project.rungs[0].id, id: null };
    applyLanguageUi();
    if (isST()) state.stEditor.setText(state.project.st);
    refreshAll();
    if (lang === 'ST' && state.project.rungs.some(r => r.logic.items.length || r.outputs.length))
      toast('O programa ladder continua salvo no projeto; volte em "Ladder" para vê-lo. A tradução LD→ST é a próxima etapa.');
  }

  let stTimer = null;
  function onStChange(text) {
    if (state.stSnapshot === null) state.stSnapshot = JSON.stringify(state.project);
    state.project.st = text;
    clearTimeout(stTimer);
    stTimer = setTimeout(() => {
      state.engine.markDirty();
      state.engine.compile();       // em RUN, o scan faz a troca online se compilou
      syncStDiagnostics();
      renderDiag();
      if (state.tab === 'tags') renderStVars();
      autosave();
    }, 250);
  }
  function onStBlur() {
    // fecha um "passo" do desfazer da aplicação ao sair do editor
    if (state.stSnapshot !== null && JSON.parse(state.stSnapshot).st !== state.project.st) {
      state.undo.push(state.stSnapshot);
      state.redo = [];
      $('#btn-undo').disabled = false;
    }
    state.stSnapshot = null;
  }

  function syncStDiagnostics() {
    if (!isST() || !state.stEditor) return;
    const c = state.engine.compiled;
    state.stEditor.setDiagnostics(c ? c.errors : [], state.engine.fault);
    renderStMonitor();
  }

  function renderStMonitor() {
    const eng = state.engine;
    state.stEditor.renderMonitor(eng.stProg, eng.running);
  }

  function currentStProgram() {
    const eng = state.engine;
    if (eng.running && eng.stProg) return eng.stProg;
    return eng.compiled && eng.compiled.st ? eng.compiled.st : null;
  }

  function renderStVars() {
    const prog = currentStProgram();
    const box = $('#tab-tags');
    const sc = state.scene;
    const ioRows = sc.io.inputs.concat(sc.io.outputs).map(([a, n, c]) =>
      `<tr><td class="mono">${esc(Addr.iec(a))}</td><td class="mono">${esc(n)}</td><td>${esc(c)}</td></tr>`).join('');
    let vars = '';
    if (!prog) vars = '<p class="hint">Corrija os erros de compilação para ver as variáveis.</p>';
    else {
      const running = state.engine.running;
      const mb = window.PLC.Modbus;
      vars = `<table class="tags vars"><thead><tr><th>Nome</th><th>Tipo</th><th>AT</th><th>Modbus</th><th>Valor</th></tr></thead><tbody>` +
        prog.decls.map(d => `<tr><td class="mono">${esc(d.display)}${d.constant ? ' <span class="muted">(const)</span>' : ''}</td>
          <td class="mono">${esc(typeLabel(d.type))}</td><td class="mono">${d.at ? esc(Addr.iec(d.at)) : ''}</td>
          <td class="small mbref" title="${d.at && mb ? esc(mb.modbusRefOf(d.at)) : ''}">${d.at && mb ? esc(shortRef(mb.modbusRefOf(d.at))) : ''}</td>
          <td class="mono val" data-var="${esc(d.name)}">${running ? '' : '—'}</td></tr>`).join('') + '</tbody></table>';
    }
    box.innerHTML = `${vars}
      <h4 class="sub">E/S da cena "${esc(sc.name)}"</h4>
      <table class="tags"><thead><tr><th>Endereço</th><th>Nome sugerido</th><th>Descrição</th></tr></thead><tbody>${ioRows}</tbody></table>
      <p class="hint">Use "Declarar E/S da cena" na barra para inserir essas declarações no VAR.</p>`;
    updateStVarValues();
  }
  /** Forma curta para caber no painel: "Holding Registers 2048–2049" -> "HR 2048–2049". */
  function shortRef(r) {
    return r.replace(/^Discrete Inputs? /, 'DI ').replace(/^Input Registers? /, 'IR ').replace(/^Holding Registers? /, 'HR ');
  }
  function typeLabel(t) { return t.kind === 'ARRAY' ? `ARRAY[${t.lo}..${t.hi}] OF ${t.elem}` : t.kind === 'FB' ? t.fb : t.kind; }

  function updateStVarValues() {
    const eng = state.engine;
    if (!eng.running || !eng.stProg) return;
    const vals = {};
    eng.stProg.variables().forEach(v => { vals[v.name.toUpperCase()] = v.value; });
    $$('#tab-tags [data-var]').forEach(td => {
      const v = vals[td.getAttribute('data-var')] || '';
      if (td.textContent !== v) td.textContent = v;
      td.classList.toggle('on', v === 'TRUE');
    });
  }

  function renderStReference() {
    const fbRows = Object.keys(ST.FBS).map(n => {
      const d = ST.FBS[n];
      const io = o => Object.keys(o).map(k => `${k}:${o[k]}`).join(', ');
      return `<tr><td class="mono"><b>${n}</b></td><td class="mono">${io(d.inputs)}</td><td class="mono">${io(d.outputs)}</td></tr>`;
    }).join('');
    $('#tab-props').innerHTML = `
      <p class="hint">Subconjunto da <b>IEC 61131-3</b>. Nomes não diferenciam maiúsculas de minúsculas. Todo comando termina com <span class="mono">;</span></p>
      <h4 class="sub">Blocos de função</h4>
      <p class="hint">Declare uma instância e chame-a numa linha própria; leia as saídas depois:
      <span class="mono">T1 : TON;</span> … <span class="mono">T1(IN := x, PT := T#2s); y := T1.Q;</span></p>
      <table class="tags"><thead><tr><th>FB</th><th>Entradas</th><th>Saídas</th></tr></thead><tbody>${fbRows}</tbody></table>
      <h4 class="sub">Tipos e literais</h4>
      <p class="mono small">BOOL (TRUE/FALSE) · INT · DINT · UINT · SINT · REAL (2.5) · TIME (T#1s500ms)<br>ARRAY[0..9] OF INT · 16#FF · 2#1010</p>
      <h4 class="sub">Endereços diretos</h4>
      <p class="mono small">%IX0.0 entrada · %QX0.0 saída · %MX0.0 memória<br>%IW0 entrada analógica · %QW0 · %MW0 (16 bits)<br>%MD0 … %MD15 (32 bits: DINT, UDINT ou REAL)</p>
      <h4 class="sub">Operadores (maior precedência primeiro)</h4>
      <p class="mono small">( ) · ** · - NOT · * / MOD · + - · &lt; &gt; &lt;= &gt;= · = &lt;&gt; · AND &amp; · XOR · OR</p>
      <h4 class="sub">Funções</h4>
      <p class="mono small">ABS SQRT MIN MAX LIMIT(MN,IN,MX) SEL(G,IN0,IN1) MOVE TRUNC<br>Conversões: INT_TO_REAL, REAL_TO_INT, DINT_TO_INT, TIME_TO_DINT, DINT_TO_TIME, BOOL_TO_INT…</p>
      <h4 class="sub">Comandos</h4>
      <p class="mono small">x := expr; · IF … THEN … ELSIF … ELSE … END_IF; · CASE n OF 1: … 2..5: … ELSE … END_CASE;<br>
      FOR i := 1 TO 10 BY 1 DO … END_FOR; · WHILE c DO … END_WHILE; · REPEAT … UNTIL c END_REPEAT; · EXIT; · RETURN;</p>`;
  }

  /** Nome livre para uma nova instância de FB (T1, T2… / C1… / Borda1…). */
  function freeInstanceName(fb) {
    const prefix = { TON: 'T', TOF: 'T', TP: 'T', CTU: 'C', CTD: 'C', CTUD: 'C', R_TRIG: 'Borda', F_TRIG: 'Borda', SR: 'Mem', RS: 'Mem' }[fb] || 'Fb';
    const used = new Set();
    const src = state.project.st || '';
    const re = /\b([A-Za-z_]\w*)\b/g; let m;
    while ((m = re.exec(src))) used.add(m[1].toUpperCase());
    for (let i = 1; i < 1000; i++) if (!used.has((prefix + i).toUpperCase())) return prefix + i;
    return prefix + 'X';
  }

  /** Acrescenta linhas antes do primeiro END_VAR (ou cria um bloco VAR). */
  function addDeclarations(lines) {
    const ta = state.stEditor.ta;
    let src = ta.value;
    const m = /^([ \t]*)END_VAR\b/im.exec(src);
    const pos = ta.selectionStart;
    let insertAt, text;
    if (m) {
      insertAt = m.index;
      text = lines.map(l => '  ' + l).join('\n') + '\n';
    } else {
      const pm = /^\s*PROGRAM\s+\w+[^\n]*\n/i.exec(src);
      insertAt = pm ? pm[0].length : 0;
      text = 'VAR\n' + lines.map(l => '  ' + l).join('\n') + '\nEND_VAR\n\n';
    }
    ta.value = src.slice(0, insertAt) + text + src.slice(insertAt);
    const np = pos >= insertAt ? pos + text.length : pos;
    ta.setSelectionRange(np, np);
    ta.dispatchEvent(new Event('input'));
  }

  function insertSnippet(sn) {
    if (sn.fb) {
      const name = freeInstanceName(sn.fb);
      state.stEditor.insert(sn.call(name));
      addDeclarations([`${name} : ${sn.fb};`]);
      toast(`Instância ${name} : ${sn.fb} declarada no VAR`);
    } else state.stEditor.insert(sn.text);
    state.stEditor.ta.focus();
  }

  function declareSceneIo() {
    const src = (state.project.st || '').toUpperCase();
    const decl = StExamples.sceneDeclarations(state.project.sceneId, '').split('\n');
    const missing = decl.filter(l => {
      const at = /AT\s+(%\S+)/.exec(l)[1].toUpperCase();
      const name = l.split(/\s/)[0].toUpperCase();
      return !src.includes(at) && !new RegExp('\\b' + name + '\\b').test(src);
    });
    if (!missing.length) { toast('Todas as E/S da cena já estão declaradas'); return; }
    addDeclarations(missing);
    toast(`${missing.length} declaração(ões) inserida(s)`);
  }

  function bindSt() {
    state.stEditor = new StEditor($('#st-host'), { onChange: onStChange, onBlur: onStBlur });
    $$('.lang-seg [data-lang]').forEach(b => b.addEventListener('click', () => setLanguage(b.getAttribute('data-lang'))));
    StExamples.SNIPPETS.forEach(sn => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-btn mono';
      b.textContent = sn.label;
      b.title = sn.title + (sn.fb ? ' (declara a instância no VAR)' : '');
      b.addEventListener('mousedown', e => e.preventDefault()); // não tira o foco/cursor do editor
      b.addEventListener('click', () => insertSnippet(sn));
      (sn.fb ? $('#stp-fb') : $('#stp-ctrl')).appendChild(b);
    });
    $('#btn-st-io').addEventListener('mousedown', e => e.preventDefault());
    $('#btn-st-io').addEventListener('click', declareSceneIo);
  }

  // ================================================================ divisória editor | painel
  /** Largura do painel lateral ajustável (arrastar) e recolhível (duplo clique); lembrada no navegador. */
  function bindSplitter() {
    const KEY = 'plc-simulator.layout.v1';
    const layout = document.querySelector('.layout');
    const sp = $('#splitter');
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { /* sem armazenamento */ }
    const apply = () => {
      if (saved.w) layout.style.setProperty('--side-w', saved.w + 'px');
      layout.classList.toggle('side-collapsed', !!saved.collapsed);
    };
    const store = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* ignora */ } };
    apply();
    sp.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = ev => {
        const total = layout.getBoundingClientRect().right;
        const w = Math.round(Math.min(Math.max(total - ev.clientX, 240), window.innerWidth * 0.6));
        saved.w = w; saved.collapsed = false;
        apply();
      };
      const up = () => {
        sp.classList.remove('dragging');
        document.body.classList.remove('resizing');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        store();
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => { saved.collapsed = !saved.collapsed; apply(); store(); });
  }

  // ================================================================ início
  bindUi();
  window.PLC.Comm.init(state.engine, $('#tab-comm'));
  const saved = loadAutosave();
  loadProject(saved || StExamples.EXAMPLES.find(e => e.id === 'st-partida').build());
  updateRunUi();
  bindSplitter();
  startClock();
  requestAnimationFrame(frame);

  // exposto para depuração no console
  window.PLC.app = state;
})();
