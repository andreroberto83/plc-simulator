/*
 * Runtime do CLP: memória, imagem de E/S e ciclo de varredura (scan).
 *
 * Ciclo de um scan (igual a um CLP real):
 *   1. copia as entradas físicas (vindas da cena) para a imagem I/IW
 *   2. executa os degraus de cima para baixo, esquerda para a direita
 *   3. copia a imagem Q/QW para as saídas físicas (lidas pela cena)
 *
 * Em STOP todas as saídas físicas ficam em 0.
 */
(function (root) {
  'use strict';
  const Addr = root.PLC.Addr;
  const Model = root.PLC.Model;

  /** Valor qualquer -> INT de 16 bits com sinal (estoura como no CLP: 32768 -> -32768). */
  function toInt16(v) { return ((Math.trunc(Number(v)) || 0) << 16) >> 16; }

  function newTimer() { return { EN: 0, TT: 0, DN: 0, ACC: 0, PRE: 0, _prevIn: 0 }; }
  function newCounter() { return { CU: 0, CD: 0, DN: 0, ACC: 0, PRE: 0 }; }

  class Engine {
    constructor() {
      this.project = null;
      this.compiled = null;
      this.dirty = true;
      this.running = false;
      this.physIn = {};     // entradas físicas (escritas pela cena)
      this.physOut = {};    // saídas físicas (lidas pela cena)
      this.reset();
    }

    reset() {
      this.bits = {};       // 'I0.0' -> 0|1
      this.words = {};      // 'IW0'  -> número
      this.dwords = new DataView(new ArrayBuffer(4 * Addr.LIMITS.MD)); // %MD: 32 bits brutos (DINT ou REAL)
      this.timers = {};     // 'T0'   -> {EN,TT,DN,ACC,PRE}
      this.counters = {};   // 'C0'   -> {CU,CD,DN,ACC,PRE}
      this.edges = {};      // id da instrução P/N -> valor anterior do bit
      this.power = {};      // id -> {i: energia na entrada, o: energia na saída}
      this.rungPower = {};  // id do degrau -> energia que chega nas saídas
      this.scanCount = 0;
      this.physOut = {};
    }

    setProject(project) { this.project = project; this.dirty = true; }
    markDirty() { this.dirty = true; Addr.invalidateSymbols(); }

    // ------------------------------------------------------ entradas/saídas
    setInput(key, value) { this.physIn[key] = value; }
    getOutput(key) { return this.physOut[key] || 0; }

    // ------------------------------------------------------ leitura/escrita
    readBit(p) {
      if (!p) return 0;
      if (p.kind === 'bit') return this.bits[p.key] ? 1 : 0;
      if (p.kind === 'timer') return this.timer(p.base)[p.field] ? 1 : 0;
      if (p.kind === 'counter') return this.counter(p.base)[p.field] ? 1 : 0;
      return 0;
    }
    readWord(p) {
      if (!p) return 0;
      if (p.kind === 'word') return this.words[p.key] || 0;
      if (p.kind === 'timer') return this.timer(p.base)[p.field] || 0;
      if (p.kind === 'counter') return this.counter(p.base)[p.field] || 0;
      if (p.kind === 'bit') return this.bits[p.key] ? 1 : 0;
      return 0;
    }
    timer(base) { return this.timers[base] || (this.timers[base] = newTimer()); }
    counter(base) { return this.counters[base] || (this.counters[base] = newCounter()); }

    /** Valor de qualquer endereço, para exibição (tabela de tags, editor). */
    peek(key) {
      const p = Addr.parse(key);
      if (!p) return undefined;
      if (p.kind === 'bit') return this.readBit(p);
      if (p.kind === 'word') return this.readWord(p);
      if (!p.field) return p.kind === 'timer' ? this.timer(p.base) : this.counter(p.base);
      return p.isWord ? this.readWord(p) : this.readBit(p);
    }

    // ------------------------------------------------------------ compilação
    /**
     * Resolve símbolos e valida operandos. Não altera o projeto.
     * Retorna { errors: [{id, rungIndex, msg}], warnings: [...] }.
     */
    compile() {
      const project = this.project;
      if (project.language === 'ST') return this.compileST();
      const errors = [], warnings = [];
      const resolved = {};          // id -> dados resolvidos
      const coilWriters = {};       // endereço -> nº de bobinas (para aviso)
      const syms = project.symbols;

      Model.forEachInstr(project, (el, rung, ri) => {
        const r = {};
        const err = msg => errors.push({ id: el.id, rungIndex: ri, msg });
        switch (el.type) {
          case 'NO': case 'NC': case 'P': case 'N': {
            const p = Addr.resolve(el.op, syms);
            if (!p) err(`Operando inválido: "${el.op || ''}"`);
            else if (!Addr.isBitAddress(p)) err(`"${el.op}" não é um bit (use por ex. I0.0, M0.1, T0.DN)`);
            else r.p = p;
            break;
          }
          case 'CMP': {
            r.a = operand(el.a, syms, err, 'A');
            r.b = operand(el.b, syms, err, 'B');
            if (Model.CMP_OPS.indexOf(el.cmp) < 0) err('Operador de comparação inválido');
            break;
          }
          case 'COIL': case 'COILN': case 'SET': case 'RST': {
            const p = Addr.resolve(el.op, syms);
            if (!p) err(`Operando inválido: "${el.op || ''}"`);
            else if (!Addr.isWritableBit(p)) err(`"${el.op}" não pode ser escrito (use Q ou M)`);
            else {
              r.p = p;
              if (el.type === 'COIL' || el.type === 'COILN') coilWriters[p.key] = (coilWriters[p.key] || 0) + 1;
            }
            break;
          }
          case 'TON': case 'TOF': case 'TP': case 'CTU': case 'CTD': {
            const want = el.type[0] === 'T' ? 'timer' : 'counter';
            const p = Addr.resolve(el.op, syms);
            if (!p || p.kind !== want || p.field) err(`Operando deve ser um ${want === 'timer' ? 'temporizador (T0..T31)' : 'contador (C0..C31)'}`);
            else r.p = p;
            const pre = Number(el.pre);
            if (!Number.isFinite(pre) || pre < 0) err('Preset inválido');
            r.pre = Number.isFinite(pre) ? Math.max(0, Math.round(pre)) : 0;
            break;
          }
          case 'RES': {
            const p = Addr.resolve(el.op, syms);
            if (!p || (p.kind !== 'timer' && p.kind !== 'counter') || p.field) err('RES precisa de um temporizador ou contador (ex.: T0, C0)');
            else r.p = p;
            break;
          }
        }
        resolved[el.id] = r;
      });

      project.rungs.forEach((rung, ri) => {
        if (rung.outputs.length === 0 && rung.logic.items.length > 0)
          warnings.push({ id: null, rungIndex: ri, msg: `Degrau ${ri + 1} não tem instrução de saída` });
      });
      for (const k of Object.keys(coilWriters)) {
        if (coilWriters[k] > 1) warnings.push({ id: null, rungIndex: -1, msg: `${k} é escrito por ${coilWriters[k]} bobinas; só a última vale (bobina dupla)` });
      }

      this.compiled = { resolved, errors, warnings };
      this.dirty = false;
      return this.compiled;
    }

    /** Texto Estruturado: compila o fonte inteiro (erros com linha/coluna). */
    compileST() {
      const r = root.PLC.ST.compile(this.project.st || '');
      this.compiled = {
        resolved: {},
        errors: r.errors.map(e => ({ id: null, rungIndex: -1, line: e.line, col: e.col, msg: e.msg })),
        warnings: [],
        st: r.program,
      };
      this.dirty = false;
      return this.compiled;
    }

    /** Acesso do programa ST à imagem de E/S e à memória M. */
    ioPort() {
      const eng = this;
      return {
        read(p, type) {
          if (p.kind === 'bit') return !!eng.bits[p.key];
          if (p.kind === 'dword') return eng.readDword(p.n, type);
          const w = eng.words[p.key] || 0;
          return type === 'UINT' ? w & 0xFFFF : w;
        },
        write(p, v, type) {
          if (p.kind === 'bit') eng.bits[p.key] = v ? 1 : 0;
          else if (p.kind === 'dword') eng.writeDword(p.n, v, type);
          else eng.words[p.key] = toInt16(v);   // palavra de 16 bits, guardada como INT com sinal
        },
      };
    }

    /** %MD: a mesma palavra de 32 bits lida como REAL (IEEE 754), UDINT ou DINT. */
    readDword(n, type) {
      const o = n * 4;
      if (type === 'REAL') return this.dwords.getFloat32(o);
      if (type === 'UDINT') return this.dwords.getUint32(o);
      return this.dwords.getInt32(o);
    }
    writeDword(n, v, type) {
      const o = n * 4;
      if (type === 'REAL') this.dwords.setFloat32(o, Number(v) || 0);
      else if (type === 'UDINT') this.dwords.setUint32(o, Math.trunc(Number(v)) >>> 0);
      else this.dwords.setInt32(o, Math.trunc(Number(v)) | 0);
    }

    /**
     * Acesso para a comunicação (Modbus). Entradas vêm do campo (cena),
     * saídas vêm das saídas físicas (zeradas em STOP) e memória vem da
     * imagem do CLP. O mestre só escreve em %M.
     */
    commData() {
      const eng = this;
      return {
        readBit(key) {
          if (key[0] === 'I') return eng.physIn[key] ? 1 : 0;
          if (key[0] === 'Q') return eng.physOut[key] ? 1 : 0;
          return eng.bits[key] ? 1 : 0;
        },
        readWord(key) {
          if (key[0] === 'I') return Math.trunc(Number(eng.physIn[key]) || 0);
          if (key[0] === 'Q') return Math.trunc(eng.physOut[key] || 0);
          return Math.trunc(eng.words[key] || 0);
        },
        writeBit(key, v) { if (key[0] === 'M') eng.bits[key] = v ? 1 : 0; },
        writeWord(key, v) { if (key[0] === 'M') eng.words[key] = v; },
        /** Metade de um %MD como registrador de 16 bits (part 0 = palavra alta, 1 = baixa). */
        readDwordHalf(n, part) { return eng.dwords.getUint16(n * 4 + part * 2); },
        writeDwordHalf(n, part, u16) { eng.dwords.setUint16(n * 4 + part * 2, u16 & 0xFFFF); },
      };
    }

    // -------------------------------------------------------------- RUN/STOP
    start() {
      if (this.dirty || !this.compiled) this.compile();
      this.reset();
      this.fault = null;
      this.stProg = null;
      if (this.project.language === 'ST') {
        this.stProg = this.compiled.st;
        if (!this.stProg) return false;
        try { this.stProg.init(this.ioPort()); }
        catch (e) { this.fault = { msg: e.message, line: e.line || 0 }; return false; }
      }
      this.running = true;
      this.firstScan = true;
      return true;
    }
    stop() {
      this.running = false;
      this.physOut = {};
    }

    /** Executa um ciclo de varredura. dt = tempo desde o último scan (ms). */
    scan(dt) {
      if (!this.running || !this.project) return;
      const isST = this.project.language === 'ST';
      if (this.dirty || !this.compiled) this.compile();
      // troca online: se o código novo compilou, entra no lugar mantendo os valores
      if (isST && this.compiled.st && this.compiled.st !== this.stProg) {
        const next = this.compiled.st;
        try { next.init(this.ioPort(), this.stProg); }
        catch (e) { this.fault = { msg: e.message, line: e.line || 0 }; this.stop(); return; }
        next.now = this.stProg ? this.stProg.now : 0;
        this.stProg = next;
      }
      const R = this.compiled.resolved;

      // 1. leitura das entradas
      for (const key of Object.keys(this.physIn)) {
        const v = this.physIn[key];
        if (key.indexOf('.') > 0) this.bits[key] = v ? 1 : 0;
        else this.words[key] = Number(v) || 0;
      }

      // 2. execução
      if (isST) {
        try { this.stProg.scan(dt); }
        catch (e) {
          if (!(e instanceof root.PLC.ST.StError)) throw e;
          this.fault = { msg: e.message, line: e.line };
          this.stop();
          return;
        }
        this.writeOutputs();
        return;
      }
      const power = {};
      for (const rung of this.project.rungs) {
        const p = this.evalSeries(rung.logic, 1, R, power);
        this.rungPower[rung.id] = p;
        for (const out of rung.outputs) {
          power[out.id] = { i: p, o: p };
          this.execOutput(out, p, R[out.id] || {}, dt);
        }
      }
      this.power = power;

      this.writeOutputs();
    }

    // 3. escrita das saídas
    writeOutputs() {
      const out = {};
      for (const key of Object.keys(this.bits)) if (key[0] === 'Q') out[key] = this.bits[key];
      for (const key of Object.keys(this.words)) if (key[0] === 'Q') out[key] = this.words[key];
      this.physOut = out;
      this.scanCount++;
      this.firstScan = false;
    }

    evalSeries(series, pin, R, power) {
      let p = pin;
      for (const it of series.items) {
        if (it.type === 'parallel') {
          let any = 0;
          // todos os ramos são avaliados (bordas P/N precisam atualizar a memória)
          for (const br of it.branches) any = this.evalSeries(br, p, R, power) || any;
          p = any;
        } else {
          // c = a condição é verdadeira (contato fechado), o = energia que passa
          const c = this.evalCond(it, R[it.id] || {});
          const o = p && c ? 1 : 0;
          power[it.id] = { i: p, o, c };
          p = o;
        }
      }
      return p ? 1 : 0;
    }

    evalCond(el, r) {
      switch (el.type) {
        case 'NO': return this.readBit(r.p) ? 1 : 0;
        case 'NC': return r.p && !this.readBit(r.p) ? 1 : 0;
        case 'P': case 'N': {
          // a borda é detectada sobre o operando, e a memória é atualizada
          // em todo scan (mesmo sem energia chegando), como no IEC 61131-3
          const cur = this.readBit(r.p);
          const prev = this.edges[el.id];
          this.edges[el.id] = cur;
          if (prev === undefined) return 0;
          const edge = el.type === 'P' ? (cur && !prev) : (!cur && prev);
          return edge ? 1 : 0;
        }
        case 'CMP': {
          if (!r.a || !r.b) return 0;
          const a = this.value(r.a), b = this.value(r.b);
          let ok = false;
          switch (el.cmp) {
            case '==': ok = a === b; break;
            case '<>': ok = a !== b; break;
            case '>': ok = a > b; break;
            case '>=': ok = a >= b; break;
            case '<': ok = a < b; break;
            case '<=': ok = a <= b; break;
          }
          return ok ? 1 : 0;
        }
      }
      return 0;
    }

    value(v) { return v.kind === 'const' ? v.value : this.readWord(v.p); }

    execOutput(el, p, r, dt) {
      if (!r.p) return;
      switch (el.type) {
        case 'COIL': this.bits[r.p.key] = p ? 1 : 0; break;
        case 'COILN': this.bits[r.p.key] = p ? 0 : 1; break;
        case 'SET': if (p) this.bits[r.p.key] = 1; break;
        case 'RST': if (p) this.bits[r.p.key] = 0; break;
        case 'TON': {
          const t = this.timer(r.p.base);
          t.PRE = r.pre;
          if (p) {
            t.EN = 1;
            t.ACC = Math.min(t.ACC + dt, t.PRE);
            t.DN = t.ACC >= t.PRE ? 1 : 0;
            t.TT = t.DN ? 0 : 1;
          } else { t.EN = 0; t.TT = 0; t.DN = 0; t.ACC = 0; }
          break;
        }
        case 'TOF': {
          const t = this.timer(r.p.base);
          t.PRE = r.pre;
          if (p) { t.EN = 1; t.DN = 1; t.TT = 0; t.ACC = 0; }
          else {
            t.EN = 0;
            if (t.DN) {
              t.ACC = Math.min(t.ACC + dt, t.PRE);
              if (t.ACC >= t.PRE) { t.DN = 0; t.TT = 0; }
              else t.TT = 1;
            }
          }
          break;
        }
        case 'TP': {
          // Pulso: na borda de subida liga DN por PRE ms, independente da entrada
          const t = this.timer(r.p.base);
          t.PRE = r.pre;
          const rising = p && !t._prevIn;
          t._prevIn = p ? 1 : 0;
          t.EN = p ? 1 : 0;
          if (rising && !t.TT) { t.TT = 1; t.DN = 1; t.ACC = 0; }
          if (t.TT) {
            t.ACC = Math.min(t.ACC + dt, t.PRE);
            if (t.ACC >= t.PRE) { t.TT = 0; t.DN = 0; }
          } else if (!p) t.ACC = 0;
          break;
        }
        case 'CTU': {
          const c = this.counter(r.p.base);
          c.PRE = r.pre;
          if (p && !c.CU) c.ACC = Math.min(c.ACC + 1, 32767);
          c.CU = p ? 1 : 0;
          c.DN = c.ACC >= c.PRE ? 1 : 0;
          break;
        }
        case 'CTD': {
          const c = this.counter(r.p.base);
          c.PRE = r.pre;
          if (p && !c.CD) c.ACC = Math.max(c.ACC - 1, -32768);
          c.CD = p ? 1 : 0;
          c.DN = c.ACC >= c.PRE ? 1 : 0;
          break;
        }
        case 'RES': {
          if (!p) break;
          if (r.p.kind === 'timer') { const t = this.timer(r.p.base); t.ACC = 0; t.DN = 0; t.TT = 0; t.EN = 0; }
          else { const c = this.counter(r.p.base); c.ACC = 0; c.DN = 0; }
          break;
        }
      }
    }
  }

  function operand(text, syms, err, label) {
    const s = String(text == null ? '' : text).trim();
    if (s !== '' && /^[-+]?\d+(\.\d+)?$/.test(s)) return { kind: 'const', value: Number(s) };
    const p = Addr.resolve(s, syms);
    if (!p) { err(`Operando ${label} inválido: "${s}"`); return null; }
    if (!Addr.isWordAddress(p) && !Addr.isBitAddress(p)) { err(`Operando ${label} precisa ser palavra ou constante (ex.: IW0, T0.ACC, 100)`); return null; }
    return { kind: 'addr', p };
  }

  root.PLC = root.PLC || {};
  root.PLC.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
