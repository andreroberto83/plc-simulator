/*
 * Texto Estruturado (ST) — subconjunto da IEC 61131-3 (3ª edição).
 *
 *   PROGRAM / END_PROGRAM (opcional), VAR / VAR CONSTANT ... END_VAR
 *   Tipos: BOOL, SINT, INT, DINT, UINT, UDINT, REAL, LREAL, TIME, ARRAY[a..b] OF <tipo>
 *   Endereços diretos: %IX0.0 %QX0.0 %MX0.0 %IW0 %QW0 %MW0  (VAR x AT %IX0.0 : BOOL;)
 *   Comandos: :=, IF/ELSIF/ELSE, CASE, FOR, WHILE, REPEAT, EXIT, RETURN, chamada de FB
 *   Operadores (precedência IEC): ( ) · ** · - NOT · * / MOD · + - · < > <= >= · = <> · AND & · XOR · OR
 *   FBs padrão: TON TOF TP CTU CTD CTUD R_TRIG F_TRIG SR RS
 *   Funções: ABS SQRT MIN MAX LIMIT SEL MOVE TRUNC e conversões X_TO_Y
 *
 * Nomes são insensíveis a maiúsculas/minúsculas, como manda a norma.
 */
(function (root) {
  'use strict';
  const Addr = root.PLC.Addr;

  class StError extends Error {
    constructor(msg, line, col) { super(msg); this.line = line || 0; this.col = col || 0; }
  }

  // ===================================================================== léxico
  const KEYWORDS = new Set([
    'PROGRAM', 'END_PROGRAM', 'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_GLOBAL', 'END_VAR', 'CONSTANT', 'RETAIN', 'AT',
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'RETURN',
    'NOT', 'AND', 'OR', 'XOR', 'MOD', 'TRUE', 'FALSE', 'ARRAY',
  ]);
  const OPS = [':=', '=>', '<=', '>=', '<>', '**', '..', '=', '<', '>', '+', '-', '*', '/', '(', ')', ',', ';', ':', '.', '[', ']', '&'];

  function parseTimeLiteral(body, line, col) {
    const s = body.replace(/_/g, '').toLowerCase();
    const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
    let m, total = 0, pos = 0;
    while ((m = re.exec(s))) {
      if (m.index !== pos) break;
      const v = parseFloat(m[1]);
      total += v * { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 }[m[2]];
      pos = re.lastIndex;
    }
    if (pos !== s.length || s.length === 0) throw new StError(`Literal de tempo inválido: T#${body} (use por ex. T#1s, T#500ms, T#1m30s)`, line, col);
    return Math.round(total);
  }

  function lex(src) {
    const toks = [];
    let i = 0, line = 1, col = 1;
    const n = src.length;
    const adv = k => { for (let j = 0; j < k; j++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } };
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(1); continue; }
      if (c === '(' && src[i + 1] === '*') {
        const l0 = line, c0 = col;
        const end = src.indexOf('*)', i + 2);
        if (end < 0) throw new StError('Comentário (* sem fechamento *)', l0, c0);
        adv(end + 2 - i); continue;
      }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') adv(1); continue; }
      const l0 = line, c0 = col;
      const push = (t, v, text) => toks.push({ t, v, text, line: l0, col: c0 });

      // literal de tempo
      let m = /^(T|TIME)#(-?[0-9a-zA-Z_.]+)/i.exec(src.slice(i, i + 64));
      if (m) { push('time', parseTimeLiteral(m[2], l0, c0), m[0]); adv(m[0].length); continue; }
      // endereço direto
      m = /^%[IQM][XWD]?\d+(\.\d+)?/i.exec(src.slice(i, i + 16));
      if (m) {
        const p = Addr.parse(m[0]);
        if (!p) throw new StError(`Endereço inválido: ${m[0]}`, l0, c0);
        push('addr', p.key, m[0].toUpperCase()); adv(m[0].length); continue;
      }
      // número com base
      m = /^(2|8|16)#([0-9a-fA-F_]+)/.exec(src.slice(i, i + 40));
      if (m) {
        const digits = m[2].replace(/_/g, '');
        if (!digits || [...digits].some(d => parseInt(d, 16) >= +m[1])) throw new StError(`Número inválido na base ${m[1]}: ${m[0]}`, l0, c0);
        push('int', parseInt(digits, +m[1]), m[0]); adv(m[0].length); continue;
      }
      // real / inteiro
      m = /^\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
      if (m) {
        const txt = m[0].replace(/_/g, '');
        if (m[1] || m[2]) push('real', parseFloat(txt), m[0]); else push('int', parseInt(txt, 10), m[0]);
        adv(m[0].length); continue;
      }
      // identificador / palavra-chave
      m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 80));
      if (m) {
        const up = m[0].toUpperCase();
        if (up === 'TRUE' || up === 'FALSE') push('bool', up === 'TRUE', m[0]);
        else if (KEYWORDS.has(up)) push('kw', up, m[0]);
        else push('id', up, m[0]);
        adv(m[0].length); continue;
      }
      if (c === "'" || c === '"') throw new StError('Strings não são suportadas nesta versão', l0, c0);
      const op = OPS.find(o => src.startsWith(o, i));
      if (op) { push('op', op, op); adv(op.length); continue; }
      throw new StError(`Caractere inesperado: "${c}"`, l0, c0);
    }
    toks.push({ t: 'eof', v: null, text: 'fim do texto', line, col });
    return toks;
  }

  // ===================================================================== sintaxe
  const BASIC_TYPES = new Set(['BOOL', 'SINT', 'INT', 'DINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'TIME']);

  class Parser {
    constructor(toks) { this.toks = toks; this.i = 0; }
    get cur() { return this.toks[this.i]; }
    peek(k) { return this.toks[this.i + (k || 1)]; }
    next() { return this.toks[this.i++]; }
    is(t, v) { const c = this.cur; return c.t === t && (v === undefined || c.v === v); }
    isKw(v) { return this.is('kw', v); }
    isOp(v) { return this.is('op', v); }
    accept(t, v) { if (this.is(t, v)) return this.next(); return null; }
    fail(msg, tok) { tok = tok || this.cur; throw new StError(msg, tok.line, tok.col); }
    expect(t, v, msg) {
      if (this.is(t, v)) return this.next();
      const what = v || t;
      this.fail(msg || `Esperado "${what}", encontrado "${this.cur.text}"`);
    }
    /** Após um comando a norma exige ';'. O erro aponta o fim do comando anterior. */
    semi() {
      if (this.accept('op', ';')) return;
      const prev = this.toks[this.i - 1];
      throw new StError(`Falta ";" depois de "${prev.text}"`, prev.line, prev.col + String(prev.text).length);
    }

    program() {
      const prog = { name: 'Main', vars: [], body: [] };
      if (this.accept('kw', 'PROGRAM')) {
        prog.name = this.expect('id', undefined, 'Esperado o nome do programa depois de PROGRAM').text;
      }
      while (this.isKw('VAR') || this.isKw('VAR_INPUT') || this.isKw('VAR_OUTPUT') || this.isKw('VAR_GLOBAL')) this.varBlock(prog.vars);
      prog.body = this.stmts(['END_PROGRAM']);
      this.accept('kw', 'END_PROGRAM');
      this.accept('op', ';');
      if (!this.is('eof')) this.fail(`Texto após o fim do programa: "${this.cur.text}"`);
      return prog;
    }

    varBlock(out) {
      this.next();
      const constant = !!this.accept('kw', 'CONSTANT');
      this.accept('kw', 'RETAIN');
      while (!this.isKw('END_VAR')) {
        if (this.is('eof')) this.fail('Falta END_VAR');
        const names = [this.expect('id', undefined, `Esperado nome de variável, encontrado "${this.cur.text}"`)];
        while (this.accept('op', ',')) names.push(this.expect('id'));
        let at = null;
        if (this.accept('kw', 'AT')) {
          const a = this.expect('addr', undefined, 'Esperado endereço direto depois de AT (ex.: %IX0.0)');
          at = a.v;
        }
        this.expect('op', ':', `Esperado ":" e o tipo da variável "${names[0].text}"`);
        const type = this.typeSpec();
        let init = null;
        if (this.accept('op', ':=')) init = type.kind === 'ARRAY' ? this.arrayInit() : this.expr();
        this.semi();
        if (at && names.length > 1) this.fail('AT só pode ser usado com uma variável por declaração', names[1]);
        for (const nm of names) out.push({ name: nm.v, display: nm.text, type, at, init, constant, line: nm.line, col: nm.col });
      }
      this.next();
      this.accept('op', ';');
    }

    typeSpec() {
      if (this.accept('kw', 'ARRAY')) {
        this.expect('op', '[');
        const lo = this.signedInt(), _ = this.expect('op', '..'), hi = this.signedInt();
        this.expect('op', ']');
        this.expect('kw', 'OF');
        const el = this.expect('id', undefined, 'Esperado o tipo dos elementos do ARRAY');
        if (!BASIC_TYPES.has(el.v)) this.fail(`ARRAY só pode ter tipos básicos, não ${el.text}`, el);
        if (hi < lo) this.fail('Limites do ARRAY invertidos', el);
        if (hi - lo > 9999) this.fail('ARRAY grande demais (máx. 10000 elementos)', el);
        return { kind: 'ARRAY', lo, hi, elem: el.v };
      }
      const t = this.expect('id', undefined, `Esperado um tipo, encontrado "${this.cur.text}"`);
      if (BASIC_TYPES.has(t.v)) return { kind: t.v === 'LREAL' ? 'REAL' : t.v };
      if (FBS[t.v]) return { kind: 'FB', fb: t.v };
      this.fail(`Tipo desconhecido: ${t.text}`, t);
    }
    signedInt() {
      const neg = !!this.accept('op', '-');
      const t = this.expect('int', undefined, 'Esperado número inteiro');
      return neg ? -t.v : t.v;
    }
    arrayInit() {
      this.expect('op', '[');
      const items = [];
      do { items.push(this.expr()); } while (this.accept('op', ','));
      this.expect('op', ']');
      return { k: 'arrinit', items };
    }

    stmts(terminators) {
      const list = [];
      while (true) {
        const c = this.cur;
        if (c.t === 'eof') break;
        if (c.t === 'kw' && terminators.includes(c.v)) break;
        if (terminators.includes('#caselabel') && this.looksLikeCaseLabel()) break;
        if (this.accept('op', ';')) continue;
        list.push(this.stmt());
      }
      return list;
    }

    stmt() {
      const t = this.cur;
      if (t.t === 'kw') {
        switch (t.v) {
          case 'IF': return this.ifStmt();
          case 'CASE': return this.caseStmt();
          case 'FOR': return this.forStmt();
          case 'WHILE': return this.whileStmt();
          case 'REPEAT': return this.repeatStmt();
          case 'EXIT': this.next(); this.semi(); return { k: 'exit', line: t.line };
          case 'RETURN': this.next(); this.semi(); return { k: 'return', line: t.line };
        }
        this.fail(`"${t.text}" inesperado aqui`);
      }
      if (t.t === 'id' || t.t === 'addr') {
        if (t.t === 'id' && this.peek().t === 'op' && this.peek().v === '(') return this.callStmt();
        const target = this.designator();
        if (this.isOp('=')) this.fail('Para atribuir use ":=" (o "=" é comparação)');
        this.expect('op', ':=', `Esperado ":=" depois de "${t.text}"`);
        const expr = this.expr();
        this.semi();
        return { k: 'assign', target, expr, line: t.line, col: t.col };
      }
      this.fail(`Comando inesperado: "${t.text}"`);
    }

    callStmt() {
      const nameTok = this.next();
      this.expect('op', '(');
      const args = [];
      if (!this.isOp(')')) {
        do {
          const pn = this.expect('id', undefined, 'Use a chamada formal: Instancia(IN := valor, PT := T#1s)');
          if (this.accept('op', ':=')) args.push({ name: pn.v, display: pn.text, expr: this.expr(), line: pn.line, col: pn.col });
          else if (this.accept('op', '=>')) args.push({ name: pn.v, display: pn.text, out: true, target: this.designator(), line: pn.line, col: pn.col });
          else this.fail('Esperado ":=" (entrada) ou "=>" (saída) no parâmetro');
        } while (this.accept('op', ','));
      }
      this.expect('op', ')');
      this.semi();
      return { k: 'call', name: nameTok.v, display: nameTok.text, args, line: nameTok.line, col: nameTok.col };
    }

    ifStmt() {
      const t = this.next();
      const branches = [];
      let cond = this.expr();
      this.expect('kw', 'THEN', 'Falta THEN no IF');
      branches.push({ cond, body: this.stmts(['ELSIF', 'ELSE', 'END_IF']) });
      let other = null;
      while (true) {
        if (this.accept('kw', 'ELSIF')) {
          cond = this.expr();
          this.expect('kw', 'THEN', 'Falta THEN no ELSIF');
          branches.push({ cond, body: this.stmts(['ELSIF', 'ELSE', 'END_IF']) });
        } else if (this.accept('kw', 'ELSE')) {
          other = this.stmts(['END_IF']);
        } else break;
      }
      this.expect('kw', 'END_IF', `Falta END_IF para o IF da linha ${t.line}`);
      this.semi();
      return { k: 'if', branches, other, line: t.line };
    }

    looksLikeCaseLabel() {
      const c = this.cur, n1 = this.peek();
      if (c.t === 'int') return n1.t === 'op' && [':', ',', '..'].includes(n1.v);
      if (c.t === 'op' && c.v === '-' && n1.t === 'int') { const n2 = this.peek(2); return n2.t === 'op' && [':', ',', '..'].includes(n2.v); }
      return false;
    }

    caseStmt() {
      const t = this.next();
      const sel = this.expr();
      this.expect('kw', 'OF', 'Falta OF no CASE');
      const cases = [];
      let other = null;
      while (!this.isKw('END_CASE')) {
        if (this.accept('kw', 'ELSE')) { other = this.stmts(['END_CASE']); break; }
        if (!this.looksLikeCaseLabel()) this.fail('Esperado um rótulo do CASE (ex.: 1: ou 2..5:)');
        const labels = [];
        do {
          const a = this.signedInt();
          if (this.accept('op', '..')) labels.push([a, this.signedInt()]);
          else labels.push([a, a]);
        } while (this.accept('op', ','));
        this.expect('op', ':');
        cases.push({ labels, body: this.stmts(['ELSE', 'END_CASE', '#caselabel']) });
      }
      this.expect('kw', 'END_CASE', `Falta END_CASE para o CASE da linha ${t.line}`);
      this.semi();
      return { k: 'case', sel, cases, other, line: t.line };
    }

    forStmt() {
      const t = this.next();
      const v = this.expect('id', undefined, 'Esperado a variável de controle do FOR');
      this.expect('op', ':=');
      const from = this.expr();
      this.expect('kw', 'TO', 'Falta TO no FOR');
      const to = this.expr();
      const by = this.accept('kw', 'BY') ? this.expr() : null;
      this.expect('kw', 'DO', 'Falta DO no FOR');
      const body = this.stmts(['END_FOR']);
      this.expect('kw', 'END_FOR', `Falta END_FOR para o FOR da linha ${t.line}`);
      this.semi();
      return { k: 'for', v: { k: 'var', name: v.v, display: v.text, line: v.line, col: v.col }, from, to, by, body, line: t.line };
    }

    whileStmt() {
      const t = this.next();
      const cond = this.expr();
      this.expect('kw', 'DO', 'Falta DO no WHILE');
      const body = this.stmts(['END_WHILE']);
      this.expect('kw', 'END_WHILE', `Falta END_WHILE para o WHILE da linha ${t.line}`);
      this.semi();
      return { k: 'while', cond, body, line: t.line };
    }

    repeatStmt() {
      const t = this.next();
      const body = this.stmts(['UNTIL']);
      this.expect('kw', 'UNTIL', `Falta UNTIL para o REPEAT da linha ${t.line}`);
      const cond = this.expr();
      this.expect('kw', 'END_REPEAT', 'Falta END_REPEAT');
      this.semi();
      return { k: 'repeat', cond, body, line: t.line };
    }

    designator() {
      const t = this.next();
      let d;
      if (t.t === 'addr') d = { k: 'addr', key: t.v, display: t.text, line: t.line, col: t.col };
      else if (t.t === 'id') d = { k: 'var', name: t.v, display: t.text, line: t.line, col: t.col };
      else this.fail(`Esperado nome de variável, encontrado "${t.text}"`, t);
      while (true) {
        if (this.accept('op', '.')) {
          const f = this.expect('id', undefined, 'Esperado nome do campo depois de "."');
          d = { k: 'member', obj: d, field: f.v, display: f.text, line: f.line, col: f.col };
        } else if (this.isOp('[')) {
          const b = this.next();
          const idx = this.expr();
          this.expect('op', ']');
          d = { k: 'index', obj: d, idx, line: b.line, col: b.col };
        } else break;
      }
      return d;
    }

    // ---------------------------------------------------------------- expressões
    expr() { return this.orE(); }
    bin(nextFn, ops) {
      let a = nextFn.call(this);
      while (true) {
        const c = this.cur;
        const op = (c.t === 'op' || c.t === 'kw') && ops.includes(c.v) ? c.v : null;
        if (!op) return a;
        this.next();
        const b = nextFn.call(this);
        a = { k: 'bin', op: op === '&' ? 'AND' : op, a, b, line: c.line, col: c.col };
      }
    }
    orE() { return this.bin(this.xorE, ['OR']); }
    xorE() { return this.bin(this.andE, ['XOR']); }
    andE() { return this.bin(this.eqE, ['AND', '&']); }
    eqE() { return this.bin(this.cmpE, ['=', '<>']); }
    cmpE() { return this.bin(this.addE, ['<', '>', '<=', '>=']); }
    addE() { return this.bin(this.mulE, ['+', '-']); }
    mulE() { return this.bin(this.unE, ['*', '/', 'MOD']); }
    unE() {
      const c = this.cur;
      if (this.accept('op', '-')) return { k: 'un', op: '-', e: this.unE(), line: c.line, col: c.col };
      if (this.accept('kw', 'NOT')) return { k: 'un', op: 'NOT', e: this.unE(), line: c.line, col: c.col };
      if (this.accept('op', '+')) return this.unE();
      return this.powE();
    }
    powE() {
      let a = this.primary();
      while (this.isOp('**')) { const c = this.next(); a = { k: 'bin', op: '**', a, b: this.primary(), line: c.line, col: c.col }; }
      return a;
    }
    primary() {
      const t = this.cur;
      switch (t.t) {
        case 'int': this.next(); return { k: 'lit', type: 'ANY_INT', v: t.v, line: t.line, col: t.col };
        case 'real': this.next(); return { k: 'lit', type: 'ANY_REAL', v: t.v, line: t.line, col: t.col };
        case 'bool': this.next(); return { k: 'lit', type: 'BOOL', v: t.v, line: t.line, col: t.col };
        case 'time': this.next(); return { k: 'lit', type: 'TIME', v: t.v, line: t.line, col: t.col };
        case 'addr': return this.designator();
        case 'id':
          if (this.peek().t === 'op' && this.peek().v === '(') {
            this.next(); this.next();
            const args = [];
            if (!this.isOp(')')) {
              do {
                // aceita também parâmetros nomeados em funções: LIMIT(MN := 0, IN := x, MX := 10)
                if (this.is('id') && this.peek().t === 'op' && this.peek().v === ':=') { this.next(); this.next(); }
                args.push(this.expr());
              } while (this.accept('op', ','));
            }
            this.expect('op', ')', `Falta ")" na chamada de ${t.text}`);
            return { k: 'fn', name: t.v, display: t.text, args, line: t.line, col: t.col };
          }
          return this.designator();
        case 'op':
          if (t.v === '(') { this.next(); const e = this.expr(); this.expect('op', ')', 'Falta ")"'); return e; }
      }
      this.fail(`Expressão esperada, encontrado "${t.text}"`);
    }
  }

  // ===================================================================== blocos de função padrão
  const B = 'BOOL', T = 'TIME', I = 'INT';
  const FBS = {
    TON: {
      inputs: { IN: B, PT: T }, outputs: { Q: B, ET: T },
      init: () => ({ IN: false, PT: 0, Q: false, ET: 0, _run: false, _t0: 0 }),
      exec(s, now) {
        if (!s.IN) { s.Q = false; s.ET = 0; s._run = false; return; }
        if (!s._run) { s._run = true; s._t0 = now; }
        s.ET = Math.min(now - s._t0, s.PT);
        s.Q = s.ET >= s.PT;
      },
    },
    TOF: {
      inputs: { IN: B, PT: T }, outputs: { Q: B, ET: T },
      init: () => ({ IN: false, PT: 0, Q: false, ET: 0, _run: false, _t0: 0 }),
      exec(s, now) {
        if (s.IN) { s.Q = true; s.ET = 0; s._run = false; return; }
        if (!s.Q) return;
        if (!s._run) { s._run = true; s._t0 = now; }
        s.ET = Math.min(now - s._t0, s.PT);
        if (s.ET >= s.PT) { s.Q = false; s._run = false; }
      },
    },
    TP: {
      inputs: { IN: B, PT: T }, outputs: { Q: B, ET: T },
      init: () => ({ IN: false, PT: 0, Q: false, ET: 0, _run: false, _t0: 0, _m: false }),
      exec(s, now) {
        const rise = s.IN && !s._m;
        s._m = s.IN;
        if (!s._run && rise) { s._run = true; s._t0 = now; s.Q = true; }
        if (s._run) {
          s.ET = Math.min(now - s._t0, s.PT);
          if (s.ET >= s.PT) { s.Q = false; s._run = false; }
        } else if (!s.IN) s.ET = 0;
      },
    },
    CTU: {
      inputs: { CU: B, R: B, PV: I }, outputs: { Q: B, CV: I },
      init: () => ({ CU: false, R: false, PV: 0, Q: false, CV: 0, _m: false }),
      exec(s) {
        if (s.R) s.CV = 0;
        else if (s.CU && !s._m && s.CV < 32767) s.CV++;
        s._m = s.CU;
        s.Q = s.CV >= s.PV;
      },
    },
    CTD: {
      inputs: { CD: B, LD: B, PV: I }, outputs: { Q: B, CV: I },
      init: () => ({ CD: false, LD: false, PV: 0, Q: false, CV: 0, _m: false }),
      exec(s) {
        if (s.LD) s.CV = s.PV;
        else if (s.CD && !s._m && s.CV > -32768) s.CV--;
        s._m = s.CD;
        s.Q = s.CV <= 0;
      },
    },
    CTUD: {
      inputs: { CU: B, CD: B, R: B, LD: B, PV: I }, outputs: { QU: B, QD: B, CV: I },
      init: () => ({ CU: false, CD: false, R: false, LD: false, PV: 0, QU: false, QD: false, CV: 0, _mu: false, _md: false }),
      exec(s) {
        if (s.R) s.CV = 0;
        else if (s.LD) s.CV = s.PV;
        else {
          const up = s.CU && !s._mu, dn = s.CD && !s._md;
          if (up && !dn && s.CV < 32767) s.CV++;
          else if (dn && !up && s.CV > -32768) s.CV--;
        }
        s._mu = s.CU; s._md = s.CD;
        s.QU = s.CV >= s.PV; s.QD = s.CV <= 0;
      },
    },
    R_TRIG: {
      inputs: { CLK: B }, outputs: { Q: B },
      init: () => ({ CLK: false, Q: false, _m: false }),
      exec(s) { s.Q = s.CLK && !s._m; s._m = s.CLK; },
    },
    F_TRIG: {
      inputs: { CLK: B }, outputs: { Q: B },
      init: () => ({ CLK: false, Q: false, _m: false }),
      exec(s) { s.Q = !s.CLK && s._m; s._m = s.CLK; },
    },
    SR: {
      inputs: { S1: B, R: B }, outputs: { Q1: B },
      init: () => ({ S1: false, R: false, Q1: false }),
      exec(s) { s.Q1 = s.S1 || (!s.R && s.Q1); },
    },
    RS: {
      inputs: { S: B, R1: B }, outputs: { Q1: B },
      init: () => ({ S: false, R1: false, Q1: false }),
      exec(s) { s.Q1 = !s.R1 && (s.S || s.Q1); },
    },
  };

  // ===================================================================== tipos
  const INT_RANGE = { SINT: [-128, 127], INT: [-32768, 32767], DINT: [-2147483648, 2147483647], UINT: [0, 65535], UDINT: [0, 4294967295] };
  const isInt = t => t === 'ANY_INT' || !!INT_RANGE[t];
  const isReal = t => t === 'REAL' || t === 'ANY_REAL';
  const isNum = t => isInt(t) || isReal(t);

  function wrapInt(v, t) {
    const r = INT_RANGE[t];
    if (!r) return v;
    const span = r[1] - r[0] + 1;
    v = Math.trunc(v);
    if (v < r[0] || v > r[1]) v = ((((v - r[0]) % span) + span) % span) + r[0];
    return v;
  }

  function coerce(v, t) {
    if (t === 'BOOL') return !!v;
    if (INT_RANGE[t]) return wrapInt(v, t);
    if (t === 'TIME') return Math.round(v);
    return Number(v);
  }

  /** Pode atribuir um valor do tipo src a um destino do tipo dst? */
  function assignable(dst, src) {
    if (dst === src) return true;
    if (dst === 'BOOL' || src === 'BOOL') return false;
    if (dst === 'TIME' || src === 'TIME') return false;
    if (isInt(dst)) return isInt(src);          // inteiros entre si (o valor é ajustado à faixa)
    if (isReal(dst)) return isNum(src);         // inteiro -> REAL é conversão implícita segura
    return false;
  }

  function fmtTime(ms) {
    if (ms === 0) return 'T#0ms';
    let s = 'T#', r = Math.abs(ms);
    if (ms < 0) s += '-';
    const parts = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
    for (const [u, k] of parts) if (r >= k) { s += Math.floor(r / k) + u; r %= k; }
    if (r) s += r + 'ms';
    return s;
  }

  function fmtValue(v, type) {
    if (type === 'BOOL') return v ? 'TRUE' : 'FALSE';
    if (type === 'TIME') return fmtTime(v);
    if (type === 'REAL') return Number.isInteger(v) ? v.toFixed(1) : String(+v.toFixed(4));
    return String(v);
  }

  // ===================================================================== funções padrão
  const CONV_TYPES = ['BOOL', 'SINT', 'INT', 'DINT', 'UINT', 'UDINT', 'REAL', 'LREAL', 'TIME'];
  function fnSignature(name, argTypes, fail) {
    const n = argTypes.length;
    const need = k => { if (n !== k) fail(`${name} espera ${k} argumento(s), recebeu ${n}`); };
    const allNumOrTime = () => argTypes.every(isNum) || argTypes.every(t => t === 'TIME');   // não mistura TIME com número
    const m = /^([A-Z]+)_TO_([A-Z]+)$/.exec(name);
    if (m && CONV_TYPES.includes(m[1]) && CONV_TYPES.includes(m[2])) {
      need(1);
      const from = m[1] === 'LREAL' ? 'REAL' : m[1], to = m[2] === 'LREAL' ? 'REAL' : m[2];
      if (!assignable(from, argTypes[0]) && !(isInt(from) && isInt(argTypes[0]))) fail(`${name} espera um ${from}, recebeu ${argTypes[0]}`);
      return {
        type: to,
        fn: a => {
          let v = a[0];
          if (to === 'BOOL') return !!v;
          if (from === 'BOOL') v = v ? 1 : 0;
          if (INT_RANGE[to] && isReal(from)) v = Math.sign(v) * Math.round(Math.abs(v));   // REAL_TO_INT arredonda (IEC); .5 se afasta do zero
          return coerce(v, to);
        },
      };
    }
    const numT = () => argTypes.some(t => isReal(t)) ? 'REAL' : (argTypes.find(t => INT_RANGE[t]) || (argTypes.every(t => t === 'TIME') ? 'TIME' : 'DINT'));
    switch (name) {
      case 'ABS': need(1); if (!isNum(argTypes[0])) fail('ABS espera número'); return { type: argTypes[0] === 'ANY_INT' ? 'DINT' : argTypes[0] === 'ANY_REAL' ? 'REAL' : argTypes[0], fn: a => Math.abs(a[0]) };
      case 'SQRT': need(1); if (!isNum(argTypes[0])) fail('SQRT espera número'); return { type: 'REAL', fn: a => { if (a[0] < 0) throw new StError('SQRT de número negativo'); return Math.sqrt(a[0]); } };
      case 'TRUNC': need(1); if (!isReal(argTypes[0])) fail('TRUNC espera REAL'); return { type: 'DINT', fn: a => Math.trunc(a[0]) };
      case 'MIN': case 'MAX':
        if (n < 2) fail(`${name} espera 2 ou mais argumentos`);
        if (!allNumOrTime()) fail(`${name} espera só números ou só TIME`);
        return { type: numT(), fn: a => (name === 'MIN' ? Math.min : Math.max)(...a) };
      case 'LIMIT':
        need(3); if (!allNumOrTime()) fail('LIMIT(MN, IN, MX) espera só números ou só TIME');
        return { type: numT(), fn: a => Math.min(Math.max(a[1], a[0]), a[2]) };
      case 'SEL':
        need(3); if (argTypes[0] !== 'BOOL') fail('SEL(G, IN0, IN1): G deve ser BOOL');
        if (!assignable(argTypes[1], argTypes[2]) && !assignable(argTypes[2], argTypes[1])) fail('SEL: IN0 e IN1 devem ter o mesmo tipo');
        return { type: argTypes[1] === 'ANY_INT' ? (argTypes[2] === 'ANY_INT' ? 'DINT' : argTypes[2]) : argTypes[1], fn: a => a[0] ? a[2] : a[1] };
      case 'MOVE': need(1); return { type: argTypes[0] === 'ANY_INT' ? 'DINT' : argTypes[0] === 'ANY_REAL' ? 'REAL' : argTypes[0], fn: a => a[0] };
    }
    return null;
  }

  // ===================================================================== compilação (verificação + ligação)
  class Compiler {
    constructor(prog) { this.prog = prog; this.errors = []; this.syms = {}; this.lines = new Set(); this.lineRefs = {}; }
    err(msg, node) { this.errors.push({ msg, line: node ? node.line : 0, col: node ? node.col : 0 }); }

    run() {
      for (const d of this.prog.vars) {
        if (this.syms[d.name]) { this.err(`Variável "${d.display}" declarada duas vezes`, d); continue; }
        if (FBS[d.name]) { this.err(`"${d.display}" é nome de bloco padrão; escolha outro nome`, d); continue; }
        if (d.at) {
          const p = Addr.parse(d.at);
          const want = p.kind === 'bit' ? 'BOOL' : 'INT';
          if (d.type.kind === 'ARRAY' || d.type.kind === 'FB') this.err('AT só vale para tipos básicos', d);
          else if (p.kind === 'bit' && d.type.kind !== 'BOOL') this.err(`${Addr.iec(d.at)} é um bit: a variável deve ser BOOL`, d);
          else if (p.kind === 'word' && !['INT', 'UINT'].includes(d.type.kind)) this.err(`${Addr.iec(d.at)} é uma palavra de 16 bits: use INT ou UINT (para 32 bits use %MD)`, d);
          else if (p.kind === 'dword' && !['DINT', 'UDINT', 'REAL'].includes(d.type.kind)) this.err(`${Addr.iec(d.at)} tem 32 bits: use DINT, UDINT ou REAL`, d);
          if (d.init) this.err('Variável com AT não pode ter valor inicial (o valor vem do endereço)', d);
          void want;
        }
        this.syms[d.name] = d;
      }
      for (const d of this.prog.vars) {
        if (!d.init) continue;
        if (d.type.kind === 'ARRAY') {
          const size = d.type.hi - d.type.lo + 1;
          if (d.init.items.length > size) this.err('Mais valores iniciais que elementos no ARRAY', d);
          d.init.items.forEach(it => { const t = this.expr(it); if (!assignable(d.type.elem === 'LREAL' ? 'REAL' : d.type.elem, t)) this.err(`Valor inicial ${t} incompatível com ${d.type.elem}`, it); });
        } else if (d.type.kind === 'FB') this.err('Instância de FB não aceita valor inicial', d);
        else {
          const t = this.expr(d.init);
          if (!assignable(d.type.kind, t)) this.err(`Valor inicial do tipo ${pretty(t)} não serve para ${d.type.kind}`, d.init);
        }
      }
      this.block(this.prog.body, { loop: 0 });
      return this.errors;
    }

    ref(line, text) {
      (this.lineRefs[line] = this.lineRefs[line] || new Set()).add(text);
    }

    block(list, ctx) { for (const s of list) this.stmt(s, ctx); }

    stmt(s, ctx) {
      this.lines.add(s.line);
      switch (s.k) {
        case 'assign': {
          const lt = this.lvalue(s.target);
          const rt = this.expr(s.expr);
          if (lt && rt && !assignable(lt, rt)) this.err(`Não é possível atribuir ${pretty(rt)} a uma variável ${lt}${hint(lt, rt)}`, s.expr);
          break;
        }
        case 'call': {
          const d = this.syms[s.name];
          if (!d) { this.err(`"${s.display}" não foi declarado`, s); break; }
          if (d.type.kind !== 'FB') { this.err(`"${s.display}" não é uma instância de bloco de função`, s); break; }
          this.ref(s.line, d.display + '.' + Object.keys(FBS[d.type.fb].outputs)[0]);
          const def = FBS[d.type.fb];
          s.decl = d;
          const seen = new Set();
          for (const a of s.args) {
            if (seen.has(a.name)) this.err(`Parâmetro ${a.display} repetido`, a);
            seen.add(a.name);
            if (a.out) {
              if (!def.outputs[a.name]) { this.err(`${d.type.fb} não tem saída ${a.display} (saídas: ${Object.keys(def.outputs).join(', ')})`, a); continue; }
              const lt = this.lvalue(a.target);
              if (lt && !assignable(lt, def.outputs[a.name])) this.err(`Saída ${a.display} é ${def.outputs[a.name]}, destino é ${lt}`, a);
            } else {
              if (!def.inputs[a.name]) { this.err(`${d.type.fb} não tem entrada ${a.display} (entradas: ${Object.keys(def.inputs).join(', ')})`, a); continue; }
              const t = this.expr(a.expr);
              if (t && !assignable(def.inputs[a.name], t)) this.err(`Entrada ${a.display} de ${d.type.fb} espera ${def.inputs[a.name]}, recebeu ${pretty(t)}${hint(def.inputs[a.name], t)}`, a.expr);
            }
          }
          break;
        }
        case 'if':
          s.branches.forEach(b => { this.cond(b.cond, 'IF'); this.block(b.body, ctx); });
          if (s.other) this.block(s.other, ctx);
          break;
        case 'case': {
          const t = this.expr(s.sel);
          if (t && !isInt(t)) this.err('O seletor do CASE deve ser inteiro', s.sel);
          s.cases.forEach(c => this.block(c.body, ctx));
          if (s.other) this.block(s.other, ctx);
          break;
        }
        case 'for': {
          const d = this.syms[s.v.name];
          if (!d) this.err(`"${s.v.display}" não foi declarado`, s.v);
          else if (!isInt(d.type.kind) || d.at) this.err('A variável do FOR deve ser inteira e sem AT', s.v);
          else if (d.constant) this.err('A variável do FOR não pode ser CONSTANT', s.v);
          s.v.decl = d;
          [s.from, s.to, s.by].forEach(e => { if (e) { const t = this.expr(e); if (t && !isInt(t)) this.err('Limites do FOR devem ser inteiros', e); } });
          this.block(s.body, { loop: ctx.loop + 1 });
          break;
        }
        case 'while': this.cond(s.cond, 'WHILE'); this.block(s.body, { loop: ctx.loop + 1 }); break;
        case 'repeat': this.block(s.body, { loop: ctx.loop + 1 }); this.cond(s.cond, 'UNTIL'); break;
        case 'exit': if (!ctx.loop) this.err('EXIT só pode ser usado dentro de FOR, WHILE ou REPEAT', s); break;
      }
    }

    cond(e, what) {
      const t = this.expr(e);
      if (t && t !== 'BOOL') this.err(`A condição do ${what} deve ser BOOL, não ${pretty(t)}`, e);
    }

    /** Tipo de um destino de atribuição (ou null se inválido). */
    lvalue(d) {
      if (d.k === 'var') {
        const decl = this.syms[d.name];
        if (!decl) { this.err(`"${d.display}" não foi declarado`, d); return null; }
        d.decl = decl;
        this.ref(d.line, decl.display);
        if (decl.constant) { this.err(`"${decl.display}" é CONSTANT e não pode ser alterado`, d); return null; }
        if (decl.at && decl.at[0] === 'I') { this.err(`"${decl.display}" está em ${Addr.iec(decl.at)}, que é entrada (somente leitura)`, d); return null; }
        if (decl.type.kind === 'FB') { this.err(`"${decl.display}" é um bloco: chame-o como ${decl.display}(...)`, d); return null; }
        if (decl.type.kind === 'ARRAY') { this.err('Não é possível atribuir um ARRAY inteiro; use um índice', d); return null; }
        return decl.type.kind;
      }
      if (d.k === 'addr') {
        if (d.key[0] === 'I') { this.err(`${d.display} é entrada (somente leitura)`, d); return null; }
        this.ref(d.line, d.display);
        return addrType(d.key);
      }
      if (d.k === 'member') {
        const base = this.fbBase(d);
        if (!base) return null;
        const def = FBS[base.type.fb];
        if (def.outputs[d.field]) { this.err(`${d.display} é saída de ${base.type.fb} e não pode ser escrita`, d); return null; }
        if (!def.inputs[d.field]) { this.err(`${base.type.fb} não tem o campo ${d.display}`, d); return null; }
        this.ref(d.line, base.display + '.' + d.display);
        return def.inputs[d.field];
      }
      if (d.k === 'index') return this.indexType(d);
      return null;
    }

    fbBase(d) {
      if (d.obj.k !== 'var') { this.err('Acesso a campo inválido', d); return null; }
      const decl = this.syms[d.obj.name];
      if (!decl) { this.err(`"${d.obj.display}" não foi declarado`, d.obj); return null; }
      if (decl.type.kind !== 'FB') { this.err(`"${decl.display}" não é um bloco de função; não tem campo ${d.display}`, d); return null; }
      d.obj.decl = decl;
      return decl;
    }

    indexType(d) {
      if (d.obj.k !== 'var') { this.err('Índice inválido', d); return null; }
      const decl = this.syms[d.obj.name];
      if (!decl) { this.err(`"${d.obj.display}" não foi declarado`, d.obj); return null; }
      if (decl.type.kind !== 'ARRAY') { this.err(`"${decl.display}" não é ARRAY`, d); return null; }
      d.obj.decl = decl;
      const t = this.expr(d.idx);
      if (t && !isInt(t)) this.err('O índice deve ser inteiro', d.idx);
      if (d.idx.k === 'lit' && (d.idx.v < decl.type.lo || d.idx.v > decl.type.hi)) this.err(`Índice ${d.idx.v} fora de [${decl.type.lo}..${decl.type.hi}]`, d.idx);
      this.ref(d.line, decl.display + '[…]');
      return decl.type.elem === 'LREAL' ? 'REAL' : decl.type.elem;
    }

    expr(e) {
      const t = this.exprT(e);
      e.type = t;
      return t;
    }
    exprT(e) {
      switch (e.k) {
        case 'lit': return e.type;
        case 'var': {
          const d = this.syms[e.name];
          if (!d) { this.err(`"${e.display}" não foi declarado`, e); return null; }
          e.decl = d;
          if (d.type.kind === 'FB') { this.err(`"${d.display}" é um bloco; use um campo, por ex. ${d.display}.Q`, e); return null; }
          if (d.type.kind === 'ARRAY') { this.err(`"${d.display}" é ARRAY; use um índice`, e); return null; }
          this.ref(e.line, d.display);
          return d.type.kind;
        }
        case 'addr':
          this.ref(e.line, e.display);
          return addrType(e.key);
        case 'member': {
          const base = this.fbBase(e);
          if (!base) return null;
          const def = FBS[base.type.fb];
          const t = def.outputs[e.field] || def.inputs[e.field];
          if (!t) { this.err(`${base.type.fb} não tem o campo ${e.display}`, e); return null; }
          this.ref(e.line, base.display + '.' + e.display);
          return t;
        }
        case 'index': return this.indexType(e);
        case 'un': {
          const t = this.expr(e.e);
          if (!t) return null;
          if (e.op === 'NOT') { if (t !== 'BOOL') this.err(`NOT espera BOOL, recebeu ${pretty(t)}`, e); return 'BOOL'; }
          if (!isNum(t) && t !== 'TIME') { this.err(`"-" espera número, recebeu ${pretty(t)}`, e); return null; }
          return t;
        }
        case 'bin': return this.binT(e);
        case 'fn': {
          if (this.syms[e.name] && this.syms[e.name].type.kind === 'FB') { this.err(`Bloco de função "${e.display}" não pode ser usado em expressão. Chame-o numa linha própria e use ${e.display}.Q`, e); return null; }
          if (FBS[e.name]) { this.err(`${e.display} é um bloco de função: declare uma instância (ex.: T1 : ${e.display};)`, e); return null; }
          const types = e.args.map(a => this.expr(a));
          if (types.some(t => !t)) return null;
          let failed = false;
          const sig = fnSignature(e.name, types, msg => { if (!failed) this.err(msg, e); failed = true; });
          if (failed) return null;
          if (!sig) { this.err(`Função desconhecida: ${e.display}`, e); return null; }
          e.fn = sig.fn;
          return sig.type;
        }
      }
      return null;
    }

    binT(e) {
      const a = this.expr(e.a), b = this.expr(e.b);
      if (!a || !b) return null;
      const op = e.op;
      const bad = () => { this.err(`Operador ${op} não aceita ${pretty(a)} com ${pretty(b)}${hint(a, b)}`, e); return null; };
      if (op === 'AND' || op === 'OR' || op === 'XOR') return a === 'BOOL' && b === 'BOOL' ? 'BOOL' : bad();
      if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        if (a === 'BOOL' || b === 'BOOL') return (a === b && (op === '=' || op === '<>')) ? 'BOOL' : bad();
        if (a === 'TIME' || b === 'TIME') return a === b ? 'BOOL' : bad();
        return isNum(a) && isNum(b) ? 'BOOL' : bad();
      }
      if (op === 'MOD') { if (!isInt(a) || !isInt(b)) return bad(); e.int = true; return intResult(a, b); }
      if (op === '**') { if (!isNum(a) || !isNum(b)) return bad(); return 'REAL'; }
      // + - * /
      if (a === 'TIME' || b === 'TIME') {
        if ((op === '+' || op === '-') && a === 'TIME' && b === 'TIME') return 'TIME';
        if ((op === '*' || op === '/') && a === 'TIME' && isNum(b)) return 'TIME';
        if (op === '*' && isNum(a) && b === 'TIME') return 'TIME';
        return bad();
      }
      if (!isNum(a) || !isNum(b)) return bad();
      if (isReal(a) || isReal(b)) return 'REAL';
      e.int = true;
      return intResult(a, b);
    }
  }

  function addrType(key) {
    const k = Addr.parse(key).kind;
    return k === 'bit' ? 'BOOL' : k === 'dword' ? 'DINT' : 'INT';
  }

  function intResult(a, b) {
    const order = ['ANY_INT', 'SINT', 'UINT', 'INT', 'DINT', 'UDINT'];
    const r = order[Math.max(order.indexOf(a), order.indexOf(b))];
    return r === 'ANY_INT' ? 'ANY_INT' : r;
  }
  function pretty(t) { return t === 'ANY_INT' ? 'inteiro' : t === 'ANY_REAL' ? 'REAL' : t; }
  function hint(dst, src) {
    if (isReal(src) && isInt(dst)) return ` — use REAL_TO_${dst === 'ANY_INT' ? 'INT' : dst}(...)`;
    if (dst === 'TIME' && isInt(src)) return ' — escreva o tempo como T#…, ou use DINT_TO_TIME(ms)';
    if (isInt(dst) && src === 'TIME') return ' — use TIME_TO_DINT(...)';
    if (dst === 'BOOL' && isNum(src)) return ' — compare com um valor, por ex. x > 0';
    return '';
  }

  // ===================================================================== execução
  const BREAK = { k: 'exit' }, RET = { k: 'return' };
  const WATCHDOG = 200000; // instruções por scan

  class Program {
    constructor(ast, compiler) {
      this.ast = ast;
      this.decls = ast.vars;
      this.stmtLines = compiler.lines;
      this.lineRefs = {};
      for (const k of Object.keys(compiler.lineRefs)) this.lineRefs[k] = Array.from(compiler.lineRefs[k]);
      this.io = null;
      this.cells = {};
      this.executed = new Set();
      this.now = 0;
    }

    /** Inicializa as variáveis (entrada em RUN). keep = valores anteriores (troca online). */
    init(io, keep) {
      this.io = io;
      this.now = 0;
      this.cells = {};   // valores iniciais são calculados a partir das declarações, nunca da execução anterior
      const cells = {};
      for (const d of this.decls) {
        const k = d.type.kind;
        const old = keep && keep.cells[d.name];
        if (d.at) { cells[d.name] = { d, io: Addr.parse(d.at) }; continue; }
        if (k === 'FB') {
          const inst = old && old.fb === d.type.fb ? old.v : FBS[d.type.fb].init();
          cells[d.name] = { d, fb: d.type.fb, v: inst }; continue;
        }
        if (k === 'ARRAY') {
          const size = d.type.hi - d.type.lo + 1, et = d.type.elem === 'LREAL' ? 'REAL' : d.type.elem;
          let arr;
          if (old && old.arr && old.v.length === size && old.et === et) arr = old.v;
          else {
            arr = new Array(size).fill(coerce(0, et));
            if (d.init) d.init.items.forEach((it, i) => { arr[i] = coerce(this.eval(it), et); });
          }
          cells[d.name] = { d, arr: true, et, v: arr }; continue;
        }
        let v;
        if (old && !old.io && !old.fb && !old.arr && old.d.type.kind === k && !d.constant) v = old.v;
        else v = d.init ? coerce(this.eval(d.init), k) : coerce(0, k);
        cells[d.name] = { d, v };
      }
      this.cells = cells;
    }

    /** Um ciclo: executa o corpo do programa. */
    scan(dt) {
      this.now += dt;
      this.executed = new Set();
      this.budget = WATCHDOG;
      try { this.block(this.ast.body); }
      catch (e) { if (e !== RET) throw e; }
    }

    block(list) {
      for (const s of list) {
        const r = this.stmt(s);
        if (r) return r;
      }
      return null;
    }

    tick(s) {
      this.executed.add(s.line);
      if (--this.budget < 0) throw new StError('Watchdog: o scan não terminou (laço infinito?). CLP em STOP.', s.line, 0);
    }

    stmt(s) {
      this.tick(s);
      switch (s.k) {
        case 'assign': this.store(s.target, this.eval(s.expr)); return null;
        case 'call': {
          const cell = this.cells[s.decl.name];
          const def = FBS[cell.fb];
          const inst = cell.v;
          for (const a of s.args) if (!a.out) inst[a.name] = coerce(this.eval(a.expr), def.inputs[a.name]);
          def.exec(inst, this.now);
          for (const a of s.args) if (a.out) this.store(a.target, inst[a.name]);
          return null;
        }
        case 'if': {
          for (const b of s.branches) if (this.eval(b.cond)) return this.block(b.body);
          return s.other ? this.block(s.other) : null;
        }
        case 'case': {
          const v = this.eval(s.sel);
          for (const c of s.cases) if (c.labels.some(([a, b]) => v >= a && v <= b)) return this.block(c.body);
          return s.other ? this.block(s.other) : null;
        }
        case 'for': {
          const cell = this.cells[s.v.decl.name];
          const t = s.v.decl.type.kind;
          const to = this.eval(s.to);
          const by = s.by ? this.eval(s.by) : 1;
          if (by === 0) throw new StError('FOR com passo BY 0', s.line, 0);
          cell.v = coerce(this.eval(s.from), t);
          while (by > 0 ? cell.v <= to : cell.v >= to) {
            const r = this.block(s.body);
            if (r === BREAK) break;
            if (r === RET) return r;
            this.tick(s);
            const nv = cell.v + by;
            if (coerce(nv, t) !== nv) break; // evita laço infinito por estouro da faixa
            cell.v = nv;
          }
          return null;
        }
        case 'while':
          while (this.eval(s.cond)) {
            const r = this.block(s.body);
            if (r === BREAK) break;
            if (r === RET) return r;
            this.tick(s);
          }
          return null;
        case 'repeat':
          do {
            const r = this.block(s.body);
            if (r === BREAK) break;
            if (r === RET) return r;
            this.tick(s);
          } while (!this.eval(s.cond));
          return null;
        case 'exit': return BREAK;
        case 'return': throw RET;
      }
      return null;
    }

    store(d, v) {
      switch (d.k) {
        case 'var': {
          const cell = this.cells[d.decl.name];
          if (cell.io) this.io.write(cell.io, v, d.decl.type.kind);
          else cell.v = coerce(v, d.decl.type.kind);
          return;
        }
        case 'addr': this.io.write(Addr.parse(d.key), v, 'DINT'); return;
        case 'member': {
          const cell = this.cells[d.obj.decl.name];
          cell.v[d.field] = coerce(v, FBS[cell.fb].inputs[d.field]);
          return;
        }
        case 'index': {
          const cell = this.cells[d.obj.decl.name];
          const i = this.indexOf(d, cell);
          cell.v[i] = coerce(v, cell.et);
          return;
        }
      }
    }

    indexOf(d, cell) {
      const idx = this.eval(d.idx);
      const { lo, hi } = cell.d.type;
      if (idx < lo || idx > hi) throw new StError(`Índice ${idx} fora dos limites de ${cell.d.display}[${lo}..${hi}]`, d.line, d.col);
      return idx - lo;
    }

    eval(e) {
      switch (e.k) {
        case 'lit': return e.v;
        case 'var': {
          const cell = this.cells[e.decl.name];
          if (!cell) return e.decl.init ? this.eval(e.decl.init) : 0; // durante init
          return cell.io ? this.io.read(cell.io, e.decl.type.kind) : cell.v;
        }
        case 'addr': return this.io.read(Addr.parse(e.key), 'DINT');
        case 'member': return this.cells[e.obj.decl.name].v[e.field];
        case 'index': { const cell = this.cells[e.obj.decl.name]; return cell.v[this.indexOf(e, cell)]; }
        case 'un': { const v = this.eval(e.e); return e.op === 'NOT' ? !v : -v; }
        case 'fn': return e.fn(e.args.map(a => this.eval(a)));
        case 'bin': {
          const op = e.op;
          if (op === 'AND') return this.eval(e.a) && this.eval(e.b) ? true : false;
          if (op === 'OR') return this.eval(e.a) || this.eval(e.b) ? true : false;
          const a = this.eval(e.a), b = this.eval(e.b);
          switch (op) {
            case 'XOR': return !!a !== !!b;
            case '=': return a === b;
            case '<>': return a !== b;
            case '<': return a < b;
            case '>': return a > b;
            case '<=': return a <= b;
            case '>=': return a >= b;
            case '+': return a + b;
            case '-': return a - b;
            case '*': return e.type === 'TIME' ? Math.round(a * b) : a * b;
            case '/':
              if (b === 0) throw new StError('Divisão por zero. CLP em STOP.', e.line, e.col);
              return e.int || e.type === 'TIME' ? Math.trunc(a / b) : a / b;
            case 'MOD':
              if (b === 0) throw new StError('MOD por zero. CLP em STOP.', e.line, e.col);
              return a % b;
            case '**': return Math.pow(a, b);
          }
        }
      }
      return 0;
    }

    // ---------------------------------------------------------------- monitoração
    /** Valor formatado de uma referência de monitoração ("Motor", "T1.Q", "%QX0.0"). */
    watch(ref) {
      if (ref.endsWith('[…]')) return null;
      if (ref[0] === '%') {
        const p = Addr.parse(ref);
        const v = this.io.read(p, 'DINT');
        return p.kind === 'bit' ? (v ? 'TRUE' : 'FALSE') : String(v);
      }
      const [base, field] = ref.split('.');
      const cell = this.cells[base.toUpperCase()];
      if (!cell) return null;
      if (field) {
        const f = field.toUpperCase();
        const def = FBS[cell.fb];
        const t = def.outputs[f] || def.inputs[f];
        return fmtValue(cell.v[f], t);
      }
      if (cell.io) { const v = this.io.read(cell.io, cell.d.type.kind); return fmtValue(cell.io.kind === 'bit' ? !!v : v, cell.d.type.kind); }
      return fmtValue(cell.v, cell.d.type.kind);
    }

    /** Lista para a tabela de variáveis. */
    variables() {
      return this.decls.map(d => {
        const cell = this.cells[d.name];
        let value = '';
        if (cell) {
          if (cell.fb) {
            const def = FBS[cell.fb];
            value = Object.keys(def.outputs).map(o => `${o}=${fmtValue(cell.v[o], def.outputs[o])}`).join(' ');
          } else if (cell.arr) value = '[' + cell.v.slice(0, 8).map(v => fmtValue(v, cell.et)).join(', ') + (cell.v.length > 8 ? ', …' : '') + ']';
          else value = this.watch(d.display) || '';
        }
        return { name: d.display, type: typeName(d.type), at: d.at ? Addr.iec(d.at) : '', value, constant: d.constant };
      });
    }
  }

  function typeName(t) {
    if (t.kind === 'ARRAY') return `ARRAY[${t.lo}..${t.hi}] OF ${t.elem}`;
    if (t.kind === 'FB') return t.fb;
    return t.kind;
  }

  /**
   * Compila o texto-fonte. Retorna { program, errors }.
   * errors: [{ line, col, msg }]; program só existe se não houver erros.
   */
  function compile(src) {
    let ast;
    try { ast = new Parser(lex(src || '')).program(); }
    catch (e) {
      if (e instanceof StError) return { program: null, errors: [{ line: e.line, col: e.col, msg: e.message }] };
      throw e;
    }
    const c = new Compiler(ast);
    let errors;
    try { errors = c.run(); }
    catch (e) {
      if (e instanceof StError) errors = c.errors.concat([{ line: e.line, col: e.col, msg: e.message }]);
      else throw e;
    }
    if (errors.length) return { program: null, errors: errors.sort((a, b) => a.line - b.line || a.col - b.col), ast };
    return { program: new Program(ast, c), errors: [], ast };
  }

  root.PLC = root.PLC || {};
  root.PLC.ST = {
    compile, lex, StError, FBS, KEYWORDS, BASIC_TYPES, fmtTime, fmtValue,
  };
})(typeof window !== 'undefined' ? window : globalThis);
