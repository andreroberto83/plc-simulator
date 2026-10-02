/*
 * Endereçamento no estilo Siemens (byte.bit), com temporizadores e contadores
 * no estilo Allen-Bradley (T0.DN, C0.ACC ...).
 *
 *   Bits  : I0.0..I7.7 (entradas), Q0.0..Q7.7 (saídas), M0.0..M31.7 (memória)
 *   Words : IW0..IW7 (entradas analógicas), QW0..QW7, MW0..MW31
 *   Timers: T0..T31  -> .EN .TT .DN (bits)  .ACC .PRE (ms)
 *   Count.: C0..C31  -> .CU .CD .DN (bits)  .ACC .PRE
 *
 * Carregado como script clássico (sem ES modules) para que index.html abra
 * direto do disco (file://) sem servidor.
 */
(function (root) {
  'use strict';

  const LIMITS = { I: 8, Q: 8, M: 32, IW: 8, QW: 8, MW: 32, MD: 16, T: 32, C: 32 };
  const RE_DWORD = /^MD(\d+)$/;   // palavra dupla (32 bits): DINT, UDINT ou REAL

  const RE_BIT = /^(I|Q|M)(\d+)\.([0-7])$/;
  const RE_WORD = /^(IW|QW|MW)(\d+)$/;
  const RE_TIMER = /^T(\d+)(?:\.(EN|TT|DN|ACC|PRE))?$/;
  const RE_COUNTER = /^C(\d+)(?:\.(CU|CD|DN|ACC|PRE))?$/;

  /**
   * Interpreta um endereço absoluto. Retorna null se inválido.
   * kind: 'bit' | 'word' | 'timer' | 'counter'
   */
  // Endereço direto IEC 61131-3: %IX0.0 %QX0.0 %MX0.0 %IW0 %QW0 %MW0
  // (também aceita %I0.0, sem o X). É convertido para a chave interna I0.0 / IW0.
  const RE_IEC = /^%([IQM])(X?|W|D)(\d+)(?:\.([0-7]))?$/;

  function parse(text) {
    if (typeof text !== 'string') return null;
    let s = text.trim().toUpperCase();
    let m;
    if ((m = RE_IEC.exec(s))) {
      const isWord = m[2] === 'W' || m[2] === 'D';
      if (isWord && m[4] !== undefined) return null;
      if (!isWord && m[4] === undefined) return null;
      s = isWord ? `${m[1]}${m[2]}${m[3]}` : `${m[1]}${m[3]}.${m[4]}`;
    }
    if ((m = RE_DWORD.exec(s))) {
      const n = +m[1];
      if (n >= LIMITS.MD) return null;
      return { kind: 'dword', area: 'MD', n, key: `MD${n}` };
    }
    if ((m = RE_BIT.exec(s))) {
      const area = m[1], byte = +m[2], bit = +m[3];
      if (byte >= LIMITS[area]) return null;
      return { kind: 'bit', area, byte, bit, key: `${area}${byte}.${bit}` };
    }
    if ((m = RE_WORD.exec(s))) {
      const area = m[1], n = +m[2];
      if (n >= LIMITS[area]) return null;
      return { kind: 'word', area, n, key: `${area}${n}` };
    }
    if ((m = RE_TIMER.exec(s))) {
      const n = +m[1];
      if (n >= LIMITS.T) return null;
      const field = m[2] || null;
      const isWord = field === 'ACC' || field === 'PRE';
      return { kind: 'timer', n, field, isWord, base: `T${n}`, key: field ? `T${n}.${field}` : `T${n}` };
    }
    if ((m = RE_COUNTER.exec(s))) {
      const n = +m[1];
      if (n >= LIMITS.C) return null;
      const field = m[2] || null;
      const isWord = field === 'ACC' || field === 'PRE';
      return { kind: 'counter', n, field, isWord, base: `C${n}`, key: field ? `C${n}.${field}` : `C${n}` };
    }
    return null;
  }

  /** Forma IEC de uma chave interna: I0.0 -> %IX0.0, IW0 -> %IW0. */
  function iec(key) {
    const p = parse(key);
    if (!p) return key;
    if (p.kind === 'bit') return `%${p.area}X${p.byte}.${p.bit}`;
    if (p.kind === 'word' || p.kind === 'dword') return `%${p.area}${p.n}`;
    return p.key;
  }

  /** Endereço que pode ser lido como bit por um contato. */
  function isBitAddress(p) {
    if (!p) return false;
    if (p.kind === 'bit') return true;
    if ((p.kind === 'timer' || p.kind === 'counter') && p.field && !p.isWord) return true;
    return false;
  }

  /** Endereço que pode ser lido como número por uma comparação. */
  function isWordAddress(p) {
    if (!p) return false;
    if (p.kind === 'word') return true;
    if ((p.kind === 'timer' || p.kind === 'counter') && p.isWord) return true;
    return false;
  }

  /** Endereço de bit que pode ser escrito por bobina / set / reset. */
  function isWritableBit(p) {
    return !!p && p.kind === 'bit' && (p.area === 'Q' || p.area === 'M');
  }

  /**
   * Resolve texto digitado pelo usuário: aceita endereço absoluto ou nome
   * simbólico da tabela de tags. Símbolos podem apontar para um timer/contador
   * e receber sufixo: "TempoPartida.DN".
   */
  function resolve(text, symbols) {
    if (typeof text !== 'string' || !text.trim()) return null;
    const direct = parse(text);
    if (direct) return direct;
    const t = text.trim();
    const index = symbolIndex(symbols);
    if (index[t.toLowerCase()]) return parse(index[t.toLowerCase()]);
    const dot = t.lastIndexOf('.');
    if (dot > 0) {
      const head = index[t.slice(0, dot).toLowerCase()];
      if (head) return parse(head + t.slice(dot));
    }
    return null;
  }

  // Cache simples do índice nome -> endereço (recalculado quando a tabela muda)
  let lastSymbols = null, lastIndex = {};
  function symbolIndex(symbols) {
    if (symbols === lastSymbols) return lastIndex;
    const idx = {};
    for (const addr of Object.keys(symbols || {})) {
      const name = symbols[addr] && symbols[addr].name;
      if (name) idx[name.trim().toLowerCase()] = addr;
    }
    lastSymbols = symbols;
    lastIndex = idx;
    return idx;
  }
  function invalidateSymbols() { lastSymbols = null; }

  /** Nome simbólico de um endereço (ou ''). */
  function symbolOf(key, symbols) {
    if (!symbols) return '';
    if (symbols[key] && symbols[key].name) return symbols[key].name;
    const dot = key.indexOf('.');
    if (dot > 0 && /^[TC]/.test(key)) {
      const base = key.slice(0, dot);
      if (symbols[base] && symbols[base].name) return symbols[base].name + key.slice(dot);
    }
    return '';
  }

  root.PLC = root.PLC || {};
  root.PLC.Addr = {
    LIMITS, parse, resolve, iec, symbolOf, invalidateSymbols,
    isBitAddress, isWordAddress, isWritableBit,
  };
})(typeof window !== 'undefined' ? window : globalThis);
