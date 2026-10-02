/*
 * Modelo do programa ladder.
 *
 * Um degrau (rung) tem:
 *   logic   : nó "series" com as condições (contatos, comparações)
 *   outputs : lista de instruções de saída, ligadas em paralelo no fim do degrau
 *
 * Nós da árvore de condições:
 *   { type:'series',   items:[nó...] }       -> E lógico, da esquerda p/ direita
 *   { type:'parallel', branches:[series...] } -> OU lógico, cada ramo é uma série
 *   { id, type:'NO'|'NC'|'P'|'N'|'CMP', ... } -> instrução de condição
 */
(function (root) {
  'use strict';

  /** Catálogo das instruções. `cond` = vai na lógica; senão é saída. */
  const INSTR = {
    NO:  { cond: true,  label: 'Contato NA',          short: 'NA',  hint: 'Fecha quando o bit é 1' },
    NC:  { cond: true,  label: 'Contato NF',          short: 'NF',  hint: 'Fecha quando o bit é 0' },
    P:   { cond: true,  label: 'Borda de subida',     short: 'P',   hint: 'Passa energia por 1 scan quando o bit vai de 0 para 1' },
    N:   { cond: true,  label: 'Borda de descida',    short: 'N',   hint: 'Passa energia por 1 scan quando o bit vai de 1 para 0' },
    CMP: { cond: true,  label: 'Comparação',          short: 'CMP', hint: 'Compara dois valores (endereço de palavra ou constante)' },
    COIL:{ cond: false, label: 'Bobina',              short: '( )', hint: 'Bit = energia do degrau' },
    COILN:{cond: false, label: 'Bobina negada',       short: '(/)', hint: 'Bit = inverso da energia do degrau' },
    SET: { cond: false, label: 'Set (liga e retém)',  short: '(S)', hint: 'Liga o bit quando energizado; ele fica ligado' },
    RST: { cond: false, label: 'Reset (desliga)',     short: '(R)', hint: 'Desliga o bit quando energizado' },
    TON: { cond: false, label: 'Temporizador TON',    short: 'TON', hint: 'Atraso na energização' },
    TOF: { cond: false, label: 'Temporizador TOF',    short: 'TOF', hint: 'Atraso na desenergização' },
    TP:  { cond: false, label: 'Temporizador de pulso', short: 'TP', hint: 'Gera pulso de duração fixa na borda de subida' },
    CTU: { cond: false, label: 'Contador crescente',  short: 'CTU', hint: 'Soma 1 a cada borda de subida' },
    CTD: { cond: false, label: 'Contador decrescente',short: 'CTD', hint: 'Subtrai 1 a cada borda de subida' },
    RES: { cond: false, label: 'Reset de T/C',        short: 'RES', hint: 'Zera temporizador ou contador' },
  };

  const CMP_OPS = ['==', '<>', '>', '>=', '<', '<='];

  let seq = 0;
  function newId(prefix) {
    seq++;
    return (prefix || 'e') + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 5);
  }

  /** Cria uma instrução com valores padrão razoáveis. */
  function createInstr(type) {
    const el = { id: newId('e'), type };
    switch (type) {
      case 'NO': case 'NC': case 'P': case 'N': el.op = 'I0.0'; break;
      case 'CMP': el.a = 'IW0'; el.cmp = '>'; el.b = '500'; break;
      case 'COIL': case 'COILN': case 'SET': case 'RST': el.op = 'Q0.0'; break;
      case 'TON': case 'TOF': case 'TP': el.op = 'T0'; el.pre = 1000; break;
      case 'CTU': case 'CTD': el.op = 'C0'; el.pre = 5; break;
      case 'RES': el.op = 'T0'; break;
      default: throw new Error('Instrução desconhecida: ' + type);
    }
    return el;
  }

  function newRung() {
    return { id: newId('r'), comment: '', logic: { type: 'series', items: [] }, outputs: [] };
  }

  function newProject() {
    return {
      format: 'plc-simulator',
      version: 1,
      name: 'Novo projeto',
      sceneId: 'painel',
      scanMs: 50,
      symbols: {},
      rungs: [newRung()],
    };
  }

  // ---------------------------------------------------------------- busca

  /**
   * Localiza um elemento pelo id. Retorna
   * { rung, rungIndex, where:'logic'|'output', parent, index, grand }
   * onde parent é a série (ou o array outputs) que contém o elemento e
   * grand é o nó paralelo que contém parent (se houver).
   */
  function locate(project, id) {
    for (let r = 0; r < project.rungs.length; r++) {
      const rung = project.rungs[r];
      const oi = rung.outputs.findIndex(o => o.id === id);
      if (oi >= 0) return { rung, rungIndex: r, where: 'output', parent: rung.outputs, index: oi, grand: null };
      const hit = findInSeries(rung.logic, id, null);
      if (hit) return Object.assign({ rung, rungIndex: r, where: 'logic' }, hit);
    }
    return null;
  }

  function findInSeries(series, id, grand) {
    for (let i = 0; i < series.items.length; i++) {
      const it = series.items[i];
      if (it.id === id) return { parent: series, index: i, grand };
      if (it.type === 'parallel') {
        for (const br of it.branches) {
          const h = findInSeries(br, id, it);
          if (h) return h;
        }
      }
    }
    return null;
  }

  function forEachInstr(project, fn) {
    project.rungs.forEach((rung, ri) => {
      walkSeries(rung.logic, el => fn(el, rung, ri));
      rung.outputs.forEach(el => fn(el, rung, ri));
    });
  }

  function walkSeries(series, fn) {
    for (const it of series.items) {
      if (it.type === 'parallel') it.branches.forEach(b => walkSeries(b, fn));
      else fn(it);
    }
  }

  // ------------------------------------------------------------- edição

  /**
   * Insere uma condição.
   *  mode 'series'   : depois do elemento selecionado (ou no fim da lógica)
   *  mode 'parallel' : em paralelo com o elemento selecionado (ou com toda a lógica)
   */
  function insertCondition(project, sel, el, mode) {
    const rung = rungForSelection(project, sel);
    const loc = sel && sel.id ? locate(project, sel.id) : null;

    if (!loc || loc.where === 'output') {
      const items = rung.logic.items;
      if (mode === 'parallel' && items.length > 0) {
        const whole = { type: 'series', items: items.slice() };
        rung.logic.items = [{ type: 'parallel', branches: [whole, { type: 'series', items: [el] }] }];
      } else {
        items.push(el);
      }
      return;
    }

    if (mode === 'series') {
      loc.parent.items.splice(loc.index + 1, 0, el);
      return;
    }

    // paralelo: se o elemento já é sozinho num ramo, só acrescenta outro ramo
    if (loc.grand && loc.parent.items.length === 1) {
      const bi = loc.grand.branches.indexOf(loc.parent);
      loc.grand.branches.splice(bi + 1, 0, { type: 'series', items: [el] });
      return;
    }
    const target = loc.parent.items[loc.index];
    loc.parent.items[loc.index] = {
      type: 'parallel',
      branches: [{ type: 'series', items: [target] }, { type: 'series', items: [el] }],
    };
  }

  function insertOutput(project, sel, el) {
    const rung = rungForSelection(project, sel);
    const loc = sel && sel.id ? locate(project, sel.id) : null;
    if (loc && loc.where === 'output') rung.outputs.splice(loc.index + 1, 0, el);
    else rung.outputs.push(el);
  }

  function rungForSelection(project, sel) {
    if (sel && sel.id) {
      const loc = locate(project, sel.id);
      if (loc) return loc.rung;
    }
    if (sel && sel.rungId) {
      const r = project.rungs.find(x => x.id === sel.rungId);
      if (r) return r;
    }
    if (!project.rungs.length) project.rungs.push(newRung());
    return project.rungs[project.rungs.length - 1];
  }

  function removeElement(project, id) {
    const loc = locate(project, id);
    if (!loc) return false;
    loc.parent.splice ? loc.parent.splice(loc.index, 1) : loc.parent.items.splice(loc.index, 1);
    if (loc.where === 'logic') normalizeSeries(loc.rung.logic);
    return true;
  }

  /** Move um elemento uma posição dentro da mesma série / lista de saídas. */
  function moveElement(project, id, delta) {
    const loc = locate(project, id);
    if (!loc) return false;
    const arr = loc.where === 'output' ? loc.parent : loc.parent.items;
    const j = loc.index + delta;
    if (j < 0 || j >= arr.length) return false;
    const tmp = arr[loc.index]; arr[loc.index] = arr[j]; arr[j] = tmp;
    return true;
  }

  /** Remove ramos vazios e desfaz paralelos de um ramo só. */
  function normalizeSeries(series) {
    const out = [];
    for (const it of series.items) {
      if (it.type !== 'parallel') { out.push(it); continue; }
      it.branches.forEach(normalizeSeries);
      it.branches = it.branches.filter(b => b.items.length > 0);
      if (it.branches.length === 0) continue;
      if (it.branches.length === 1) out.push(...it.branches[0].items);
      else out.push(it);
    }
    series.items = out;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Cópia de um elemento/rung com ids novos (para colar). */
  function reId(node) {
    if (Array.isArray(node)) return node.forEach(reId);
    if (!node || typeof node !== 'object') return;
    if (node.id) node.id = newId(node.logic ? 'r' : 'e');
    if (node.items) node.items.forEach(reId);
    if (node.branches) node.branches.forEach(reId);
    if (node.logic) reId(node.logic);
    if (node.outputs) node.outputs.forEach(reId);
  }

  /** Validação estrutural de um projeto carregado de arquivo. */
  function validateProject(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.rungs)) throw new Error('Arquivo não é um projeto válido (falta "rungs").');
    p.symbols = p.symbols && typeof p.symbols === 'object' ? p.symbols : {};
    p.scanMs = Number(p.scanMs) || 50;
    p.name = p.name || 'Projeto';
    p.sceneId = p.sceneId || 'painel';
    for (const r of p.rungs) {
      if (!r.id) r.id = newId('r');
      if (!r.logic || r.logic.type !== 'series') r.logic = { type: 'series', items: [] };
      if (!Array.isArray(r.outputs)) r.outputs = [];
      checkSeries(r.logic);
      for (const o of r.outputs) {
        if (!INSTR[o.type] || INSTR[o.type].cond) throw new Error('Saída inválida: ' + o.type);
        if (!o.id) o.id = newId('e');
      }
      normalizeSeries(r.logic);
    }
    return p;
  }
  function checkSeries(s) {
    if (!Array.isArray(s.items)) s.items = [];
    for (const it of s.items) {
      if (it.type === 'parallel') {
        if (!Array.isArray(it.branches)) throw new Error('Paralelo sem ramos');
        it.branches.forEach(checkSeries);
      } else {
        if (!INSTR[it.type] || !INSTR[it.type].cond) throw new Error('Condição inválida: ' + it.type);
        if (!it.id) it.id = newId('e');
      }
    }
  }

  root.PLC = root.PLC || {};
  root.PLC.Model = {
    INSTR, CMP_OPS, newId, createInstr, newRung, newProject,
    locate, forEachInstr, walkSeries,
    insertCondition, insertOutput, removeElement, moveElement, normalizeSeries,
    clone, reId, validateProject,
  };
})(typeof window !== 'undefined' ? window : globalThis);
