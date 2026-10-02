/*
 * Desenho do diagrama ladder em SVG.
 *
 * Layout em "células": cada instrução ocupa 1 célula; série soma larguras,
 * paralelo soma alturas. As saídas ficam alinhadas à direita, junto do
 * barramento direito, e todos os degraus usam a mesma largura para que os
 * barramentos fiquem alinhados.
 */
(function (root) {
  'use strict';
  const Addr = root.PLC.Addr;
  const Model = root.PLC.Model;

  const CW = 104;        // largura da célula (px)
  const CH = 76;         // altura da célula (px)
  const RAIL_X = 14;     // x do barramento esquerdo
  const PAD = 0.14;      // folga (em células) nas bordas de um paralelo
  const MIN_COLS = 7;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function clip(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  // ------------------------------------------------------------- medidas
  function measure(node) {
    if (node.type === 'series') {
      if (!node.items.length) return { w: 1, h: 1 };
      let w = 0, h = 1;
      for (const it of node.items) { const m = measure(it); w += m.w; h = Math.max(h, m.h); }
      return { w, h };
    }
    if (node.type === 'parallel') {
      let w = 0, h = 0;
      for (const b of node.branches) { const m = measure(b); w = Math.max(w, m.w); h += m.h; }
      return { w: w + 2 * PAD, h };
    }
    return { w: 1, h: 1 };
  }

  /** Nº de colunas comum a todos os degraus. */
  function columnsFor(project) {
    let cols = MIN_COLS;
    for (const r of project.rungs) cols = Math.max(cols, Math.ceil(measure(r.logic).w) + 2);
    return cols;
  }

  // ------------------------------------------------------------ desenho
  class Painter {
    constructor(ctx) {
      this.ctx = ctx;   // { power, running, selectedId, errors, symbols, engine }
      this.out = [];
    }
    px(x) { return RAIL_X + x * CW; }
    py(y) { return y * CH; }
    cy(y) { return y * CH + CH / 2; }

    wire(x1, y1, x2, y2, on) {
      this.out.push(`<line class="w${on ? ' on' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }

    /** Desenha uma série a partir da célula (x,y) com largura W. Retorna energia na saída. */
    series(s, x, y, W, pin) {
      let cx = x, p = pin;
      for (const it of s.items) {
        const m = measure(it);
        p = it.type === 'parallel' ? this.parallel(it, cx, y, m.w, p) : this.instr(it, cx, y, p);
        cx += m.w;
      }
      if (cx < x + W - 1e-6 || !s.items.length) this.wire(this.px(cx), this.cy(y), this.px(x + W), this.cy(y), p);
      return p;
    }

    parallel(node, x, y, W, pin) {
      const inner = W - 2 * PAD;
      let by = y, any = 0, lastY = y;
      for (const br of node.branches) {
        const m = measure(br);
        const o = this.series(br, x + PAD, by, inner, pin);
        any = any || o;
        lastY = by;
        by += m.h;
      }
      const xl = this.px(x + PAD), xr = this.px(x + W - PAD);
      this.wire(this.px(x), this.cy(y), xl, this.cy(y), pin);
      this.wire(xr, this.cy(y), this.px(x + W), this.cy(y), any);
      this.wire(xl, this.cy(y), xl, this.cy(lastY), pin);
      this.wire(xr, this.cy(y), xr, this.cy(lastY), any);
      return any ? 1 : 0;
    }

    /** Uma instrução numa célula. pin só é usado se o CLP não estiver rodando. */
    instr(el, x, y) {
      const st = this.ctx.power[el.id];
      const running = this.ctx.running;
      const pin = running && st ? st.i : 0;
      const pout = running && st ? st.o : 0;
      const closed = running && st && st.c;
      const x0 = this.px(x), x1 = this.px(x + 1), yc = this.cy(y), top = this.py(y);
      const mid = (x0 + x1) / 2;
      const sel = this.ctx.selectedId === el.id;
      const err = this.ctx.errors[el.id];
      const info = Model.INSTR[el.type];
      const cls = ['el', sel ? 'sel' : '', err ? 'err' : '', closed ? 'closed' : ''].join(' ');
      const o = this.out;

      o.push(`<g class="${cls}" data-id="${el.id}">`);
      o.push(`<rect class="hit" x="${x0 + 2}" y="${top + 2}" width="${CW - 4}" height="${CH - 4}" rx="6"><title>${esc(info.label + (err ? ' — ' + err : ''))}</title></rect>`);

      const opLabel = (text, sub) => {
        o.push(`<text class="op" x="${mid}" y="${yc - 18}" text-anchor="middle">${esc(text)}</text>`);
        if (sub) o.push(`<text class="sym" x="${mid}" y="${yc + 27}" text-anchor="middle">${esc(sub)}</text>`);
      };
      const subFor = op => {
        const p = Addr.resolve(op, this.ctx.symbols);
        if (!p) return '';
        const sym = Addr.symbolOf(p.key, this.ctx.symbols);
        // se o usuário digitou o símbolo, mostra o endereço embaixo e vice-versa
        return sym && sym.toLowerCase() !== String(op).trim().toLowerCase() ? sym : (sym ? p.key : '');
      };

      switch (el.type) {
        case 'NO': case 'NC': case 'P': case 'N': {
          const hw = 9;
          this.wire(x0, yc, mid - hw, yc, pin);
          this.wire(mid + hw, yc, x1, yc, pout);
          o.push(`<rect class="cfill" x="${mid - hw}" y="${yc - 12}" width="${hw * 2}" height="24"/>`);
          o.push(`<line class="sym-line" x1="${mid - hw}" y1="${yc - 13}" x2="${mid - hw}" y2="${yc + 13}"/>`);
          o.push(`<line class="sym-line" x1="${mid + hw}" y1="${yc - 13}" x2="${mid + hw}" y2="${yc + 13}"/>`);
          if (el.type === 'NC') o.push(`<line class="sym-line" x1="${mid - hw - 3}" y1="${yc + 11}" x2="${mid + hw + 3}" y2="${yc - 11}"/>`);
          if (el.type === 'P' || el.type === 'N') o.push(`<text class="inner" x="${mid}" y="${yc + 4}" text-anchor="middle">${el.type}</text>`);
          opLabel(el.op, subFor(el.op));
          break;
        }
        case 'CMP': {
          const bw = CW - 12, bh = 58;
          this.wire(x0, yc, mid - bw / 2, yc, pin);
          this.wire(mid + bw / 2, yc, x1, yc, pout);
          o.push(`<rect class="box${closed ? ' on' : ''}" x="${mid - bw / 2}" y="${yc - bh / 2}" width="${bw}" height="${bh}" rx="3"/>`);
          const xl = mid - bw / 2 + 5, xr = mid + bw / 2 - 5;
          o.push(`<text class="box-h" x="${mid}" y="${yc - bh / 2 + 13}" text-anchor="middle">CMP ${esc(el.cmp === '<>' ? '≠' : el.cmp)}</text>`);
          [[el.a, yc + 6], [el.b, yc + 21]].forEach(([txt, ty]) => {
            o.push(`<text class="box-t" x="${xl}" y="${ty}">${esc(clip(txt, running ? 8 : 13))}</text>`);
            if (running) o.push(`<text class="box-v" x="${xr}" y="${ty}" text-anchor="end">${esc(clip(this.liveValue(txt), 5))}</text>`);
          });
          break;
        }
        case 'COIL': case 'COILN': case 'SET': case 'RST': case 'RES': {
          const on = this.outputBit(el);
          const r = 13;
          this.wire(x0, yc, mid - r, yc, pin);
          this.wire(mid + r, yc, x1, yc, 0);
          o.push(`<path class="coil${on ? ' on' : ''}" d="M ${mid - r + 5} ${yc - 14} A 16 16 0 0 0 ${mid - r + 5} ${yc + 14} M ${mid + r - 5} ${yc - 14} A 16 16 0 0 1 ${mid + r - 5} ${yc + 14}"/>`);
          const letter = { COIL: '', COILN: '/', SET: 'S', RST: 'R', RES: 'RES' }[el.type];
          if (letter) o.push(`<text class="inner${letter.length > 1 ? ' small' : ''}" x="${mid}" y="${yc + 4}" text-anchor="middle">${letter}</text>`);
          opLabel(el.op, subFor(el.op));
          break;
        }
        case 'TON': case 'TOF': case 'TP': case 'CTU': case 'CTD': {
          const bw = 80, bh = 60;
          this.wire(x0, yc, mid - bw / 2, yc, pin);
          this.wire(mid + bw / 2, yc, x1, yc, 0);
          const t = el.type[0] === 'T';
          const p = Addr.resolve(el.op, this.ctx.symbols);
          let acc = 0, dn = 0;
          if (running && p && !p.field && this.ctx.engine) {
            const obj = t ? this.ctx.engine.timers[p.base] : this.ctx.engine.counters[p.base];
            if (obj) { acc = obj.ACC; dn = obj.DN; }
          }
          const fmt = v => t ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 's' : String(v);
          o.push(`<rect class="box${dn ? ' on' : ''}" x="${mid - bw / 2}" y="${yc - bh / 2}" width="${bw}" height="${bh}" rx="3"/>`);
          o.push(`<text class="box-h" x="${mid}" y="${yc - bh / 2 + 13}" text-anchor="middle">${el.type} ${esc(el.op)}</text>`);
          const sym = p ? Addr.symbolOf(p.key, this.ctx.symbols) : '';
          if (sym && sym.toLowerCase() !== String(el.op).toLowerCase()) o.push(`<text class="box-s" x="${mid}" y="${yc - 3}" text-anchor="middle">${esc(sym)}</text>`);
          o.push(`<text class="box-v" x="${mid}" y="${yc + 12}" text-anchor="middle">PRE ${fmt(Number(el.pre) || 0)}</text>`);
          o.push(`<text class="box-v" x="${mid}" y="${yc + 25}" text-anchor="middle">ACC ${running ? fmt(acc) : '—'}</text>`);
          break;
        }
      }
      o.push('</g>');
      return running && st ? st.o : 0;
    }

    liveValue(text) {
      const s = String(text).trim();
      if (/^[-+]?\d+(\.\d+)?$/.test(s)) return s;
      const p = Addr.resolve(s, this.ctx.symbols);
      if (!p || !this.ctx.engine) return '?';
      const v = this.ctx.engine.peek(p.key);
      return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : '?';
    }

    outputBit(el) {
      if (!this.ctx.running || !this.ctx.engine) return 0;
      const p = Addr.resolve(el.op, this.ctx.symbols);
      if (!p) return 0;
      if (el.type === 'RES') return this.ctx.power[el.id] && this.ctx.power[el.id].i;
      return this.ctx.engine.peek(p.key) ? 1 : 0;
    }
  }

  /**
   * Gera o SVG de um degrau.
   * ctx: { power, rungPower, running, selectedId, errors, symbols, engine, cols }
   */
  function renderRung(rung, ctx) {
    const P = new Painter(ctx);
    const cols = ctx.cols;
    const lm = measure(rung.logic);
    const rows = Math.max(1, Math.ceil(lm.h), rung.outputs.length);
    const outX = cols - 1;
    const logicW = outX;
    const height = rows * CH;
    const width = RAIL_X * 2 + cols * CW;
    const running = ctx.running;
    const rp = running ? (ctx.rungPower[rung.id] || 0) : 0;

    // barramentos
    P.out.push(`<line class="rail${running ? ' on' : ''}" x1="${RAIL_X}" y1="0" x2="${RAIL_X}" y2="${height}"/>`);
    P.out.push(`<line class="rail" x1="${P.px(cols)}" y1="0" x2="${P.px(cols)}" y2="${height}"/>`);

    // lógica (com energia 1 no barramento esquerdo quando rodando)
    P.series(rung.logic, 0, 0, logicW, running ? 1 : 0);

    // saídas
    if (rung.outputs.length === 0) {
      P.out.push(`<g class="slot" data-rung-out="${rung.id}"><rect class="hit" x="${P.px(outX) + 2}" y="2" width="${CW - 4}" height="${CH - 4}" rx="6"/>` +
        `<text class="placeholder" x="${P.px(outX) + CW / 2}" y="${CH / 2 + 4}" text-anchor="middle">saída?</text></g>`);
      P.wire(P.px(outX + 1), P.cy(0), P.px(cols), P.cy(0), 0);
    }
    rung.outputs.forEach((el, i) => {
      P.instr(el, outX, i, 0);
    });
    if (rung.outputs.length > 1) {
      const xl = P.px(outX), xr = P.px(outX + 1);
      P.wire(xl, P.cy(0), xl, P.cy(rung.outputs.length - 1), rp);
      P.wire(xr, P.cy(0), xr, P.cy(rung.outputs.length - 1), 0);
    }

    return `<svg class="rung-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${P.out.join('')}</svg>`;
  }

  root.PLC = root.PLC || {};
  root.PLC.LadderView = { renderRung, columnsFor, measure, CW, CH };
})(typeof window !== 'undefined' ? window : globalThis);
