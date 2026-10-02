/*
 * Modbus escravo (servidor) — núcleo sem dependências, usado pela página
 * (RTU via Web Serial, TCP via gateway) e pelos testes em Node.
 *
 * Funções: 01 Read Coils, 02 Read Discrete Inputs, 03 Read Holding Registers,
 *          04 Read Input Registers, 05 Write Single Coil, 06 Write Single Register,
 *          15 Write Multiple Coils, 16 Write Multiple Registers.
 * Exceções: 01 função ilegal, 02 endereço ilegal, 03 valor ilegal, 04 falha do escravo.
 *
 * Mapa de endereços (base 0, como no Node-RED), no estilo do OpenPLC:
 *
 *   Discrete Inputs  (FC02)     0..63   -> %IX0.0..%IX7.7        leitura
 *   Coils            (FC01)     0..63   -> %QX0.0..%QX7.7        leitura
 *   Coils            (FC01/05/15) 1024..1279 -> %MX0.0..%MX31.7  leitura e escrita
 *   Input Registers  (FC04)     0..7    -> %IW0..%IW7            leitura
 *   Holding Registers(FC03)     0..7    -> %QW0..%QW7            leitura
 *   Holding Registers(FC03/06/16) 1024..1055 -> %MW0..%MW31      leitura e escrita
 *   Holding Registers(FC03/06/16) 2048..2079 -> %MD0..%MD15      leitura e escrita
 *       (32 bits: DINT, UDINT ou REAL, dois registradores por variável;
 *        ordem das palavras configurável: ABCD = alta primeiro, CDAB = baixa primeiro)
 *
 * O mestre (supervisório) só escreve na memória %M; entradas e saídas
 * pertencem ao processo e ao programa.
 */
(function (root) {
  'use strict';

  const EX = { ILLEGAL_FUNCTION: 1, ILLEGAL_ADDRESS: 2, ILLEGAL_VALUE: 3, SLAVE_FAILURE: 4, GATEWAY_NO_RESPONSE: 0x0B };
  const FC_NAMES = { 1: 'Read Coils', 2: 'Read Discrete Inputs', 3: 'Read Holding Registers', 4: 'Read Input Registers', 5: 'Write Single Coil', 6: 'Write Single Register', 15: 'Write Multiple Coils', 16: 'Write Multiple Registers' };

  // ------------------------------------------------------------------ mapa
  const MAP = [
    { table: 'coil',     start: 0,    count: 64,  area: 'Q', kind: 'bit',  write: false, label: '%QX0.0 … %QX7.7' },
    { table: 'coil',     start: 1024, count: 256, area: 'M', kind: 'bit',  write: true,  label: '%MX0.0 … %MX31.7' },
    { table: 'discrete', start: 0,    count: 64,  area: 'I', kind: 'bit',  write: false, label: '%IX0.0 … %IX7.7' },
    { table: 'input',    start: 0,    count: 8,   area: 'IW', kind: 'word', write: false, label: '%IW0 … %IW7' },
    { table: 'holding',  start: 0,    count: 8,   area: 'QW', kind: 'word', write: false, label: '%QW0 … %QW7' },
    { table: 'holding',  start: 1024, count: 32,  area: 'MW', kind: 'word', write: true,  label: '%MW0 … %MW31' },
    { table: 'holding',  start: 2048, count: 32,  area: 'MD', kind: 'dword', write: true, label: '%MD0 … %MD15 (2 reg. cada)' },
  ];

  /** Endereço Modbus -> chave interna (I0.0, MW3...) ou null. */
  function resolve(table, addr) {
    for (const m of MAP) {
      if (m.table !== table || addr < m.start || addr >= m.start + m.count) continue;
      const off = addr - m.start;
      if (m.kind === 'dword') return { key: `MD${off >> 1}`, dword: off >> 1, pos: off & 1, write: m.write };
      const key = m.kind === 'bit' ? `${m.area}${off >> 3}.${off & 7}` : `${m.area}${off}`;
      return { key, write: m.write };
    }
    return null;
  }

  /** Endereço IEC -> referência Modbus, para exibir na tela ("Coil 1026"). */
  function modbusRefOf(key) {
    const bit = /^(I|Q|M)(\d+)\.(\d)$/.exec(key);
    if (bit) {
      const off = +bit[2] * 8 + +bit[3];
      if (bit[1] === 'I') return `Discrete Input ${off}`;
      if (bit[1] === 'Q') return `Coil ${off}`;
      return `Coil ${1024 + off}`;
    }
    const d = /^MD(\d+)$/.exec(key);
    if (d) return `Holding Registers ${2048 + 2 * d[1]}–${2049 + 2 * d[1]}`;
    const w = /^(IW|QW|MW)(\d+)$/.exec(key);
    if (w) {
      if (w[1] === 'IW') return `Input Register ${w[2]}`;
      if (w[1] === 'QW') return `Holding Register ${w[2]}`;
      return `Holding Register ${1024 + +w[2]}`;
    }
    return '';
  }

  // ------------------------------------------------------------------ CRC
  const CRC_TABLE = (() => {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xA001 : c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  function crc16(buf, start, end) {
    let crc = 0xFFFF;
    for (let i = start || 0; i < (end == null ? buf.length : end); i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
    return crc;
  }

  // ------------------------------------------------------------------ escravo
  /**
   * data: objeto de acesso à memória do CLP
   *   readBit(key) -> 0|1       writeBit(key, 0|1)
   *   readWord(key) -> inteiro  writeWord(key, inteiro com sinal)
   */
  class ModbusSlave {
    constructor(data, opts) {
      this.data = data;
      this.unitId = (opts && opts.unitId) || 1;
      this.wordOrder = (opts && opts.wordOrder) || 'ABCD';   // 32 bits: ABCD = palavra alta primeiro
      this.stats = { requests: 0, exceptions: 0, lastFc: null };
      this.onRequest = null;   // callback(info) para o log da tela
    }

    /** Processa um PDU (sem endereço/CRC). Retorna o PDU de resposta. */
    handlePdu(pdu) {
      this.stats.requests++;
      const fc = pdu[0];
      this.stats.lastFc = fc;
      let res, info = { fc, name: FC_NAMES[fc] || `FC ${fc}` };
      try {
        res = this.exec(pdu, info);
      } catch (e) {
        const code = typeof e === 'number' ? e : EX.SLAVE_FAILURE;
        this.stats.exceptions++;
        info.exception = code;
        res = Uint8Array.of(fc | 0x80, code);
      }
      if (this.onRequest) this.onRequest(info);
      return res;
    }

    exec(pdu, info) {
      const fc = pdu[0];
      const u16 = i => (pdu[i] << 8) | pdu[i + 1];
      const need = n => { if (pdu.length < n) throw EX.ILLEGAL_VALUE; };
      switch (fc) {
        case 1: case 2: {
          need(5);
          const addr = u16(1), qty = u16(3);
          info.addr = addr; info.qty = qty;
          if (qty < 1 || qty > 2000) throw EX.ILLEGAL_VALUE;
          const table = fc === 1 ? 'coil' : 'discrete';
          const nbytes = Math.ceil(qty / 8);
          const out = new Uint8Array(2 + nbytes);
          out[0] = fc; out[1] = nbytes;
          for (let i = 0; i < qty; i++) {
            const r = resolve(table, addr + i);
            if (!r) throw EX.ILLEGAL_ADDRESS;
            if (this.data.readBit(r.key)) out[2 + (i >> 3)] |= 1 << (i & 7);
          }
          return out;
        }
        case 3: case 4: {
          need(5);
          const addr = u16(1), qty = u16(3);
          info.addr = addr; info.qty = qty;
          if (qty < 1 || qty > 125) throw EX.ILLEGAL_VALUE;
          const table = fc === 3 ? 'holding' : 'input';
          const out = new Uint8Array(2 + qty * 2);
          out[0] = fc; out[1] = qty * 2;
          for (let i = 0; i < qty; i++) {
            const r = resolve(table, addr + i);
            if (!r) throw EX.ILLEGAL_ADDRESS;
            const v = r.dword != null ? this.data.readDwordHalf(r.dword, this.part(r.pos)) : this.data.readWord(r.key) & 0xFFFF;
            out[2 + i * 2] = v >> 8; out[3 + i * 2] = v & 0xFF;
          }
          return out;
        }
        case 5: {
          need(5);
          const addr = u16(1), val = u16(3);
          info.addr = addr; info.qty = 1;
          if (val !== 0xFF00 && val !== 0x0000) throw EX.ILLEGAL_VALUE;
          const r = resolve('coil', addr);
          if (!r || !r.write) throw EX.ILLEGAL_ADDRESS;
          this.data.writeBit(r.key, val === 0xFF00 ? 1 : 0);
          info.write = true;
          return pdu.slice(0, 5);
        }
        case 6: {
          need(5);
          const addr = u16(1), val = u16(3);
          info.addr = addr; info.qty = 1;
          const r = resolve('holding', addr);
          if (!r || !r.write) throw EX.ILLEGAL_ADDRESS;
          this.writeReg(r, val);
          info.write = true;
          return pdu.slice(0, 5);
        }
        case 15: {
          need(6);
          const addr = u16(1), qty = u16(3), nbytes = pdu[5];
          info.addr = addr; info.qty = qty;
          if (qty < 1 || qty > 1968 || nbytes !== Math.ceil(qty / 8) || pdu.length < 6 + nbytes) throw EX.ILLEGAL_VALUE;
          const refs = [];
          for (let i = 0; i < qty; i++) {
            const r = resolve('coil', addr + i);
            if (!r || !r.write) throw EX.ILLEGAL_ADDRESS;
            refs.push(r);
          }
          refs.forEach((r, i) => this.data.writeBit(r.key, (pdu[6 + (i >> 3)] >> (i & 7)) & 1));
          info.write = true;
          return pdu.slice(0, 5);
        }
        case 16: {
          need(6);
          const addr = u16(1), qty = u16(3), nbytes = pdu[5];
          info.addr = addr; info.qty = qty;
          if (qty < 1 || qty > 123 || nbytes !== qty * 2 || pdu.length < 6 + nbytes) throw EX.ILLEGAL_VALUE;
          const refs = [];
          for (let i = 0; i < qty; i++) {
            const r = resolve('holding', addr + i);
            if (!r || !r.write) throw EX.ILLEGAL_ADDRESS;
            refs.push(r);
          }
          refs.forEach((r, i) => this.writeReg(r, u16(6 + i * 2)));
          info.write = true;
          return pdu.slice(0, 5);
        }
      }
      throw EX.ILLEGAL_FUNCTION;
    }

    /** Posição do registrador no par -> metade do valor de 32 bits (0 = alta, 1 = baixa). */
    part(pos) { return this.wordOrder === 'CDAB' ? 1 - pos : pos; }

    writeReg(r, u16) {
      if (r.dword != null) this.data.writeDwordHalf(r.dword, this.part(r.pos), u16);
      else this.data.writeWord(r.key, u16 > 32767 ? u16 - 65536 : u16);
    }

    // -------------------------------------------------------------- RTU
    /** Processa um quadro RTU completo (com CRC já conferido). Retorna o quadro de resposta ou null. */
    handleRtuFrame(frame) {
      const unit = frame[0];
      if (unit !== this.unitId && unit !== 0) return null;          // outro escravo
      const res = this.handlePdu(frame.subarray(1, frame.length - 2));
      if (unit === 0) return null;                                   // broadcast: executa sem responder
      const out = new Uint8Array(res.length + 3);
      out[0] = unit; out.set(res, 1);
      const crc = crc16(out, 0, out.length - 2);
      out[out.length - 2] = crc & 0xFF; out[out.length - 1] = crc >> 8;
      return out;
    }

    // -------------------------------------------------------------- TCP
    /** Processa um ADU Modbus TCP (MBAP + PDU). Retorna o ADU de resposta ou null se inválido. */
    handleTcpAdu(adu) {
      if (adu.length < 8) return null;
      const proto = (adu[2] << 8) | adu[3];
      if (proto !== 0) return null;
      const len = (adu[4] << 8) | adu[5];
      if (adu.length < 6 + len) return null;
      const res = this.handlePdu(adu.subarray(7, 6 + len));
      const out = new Uint8Array(7 + res.length);
      out[0] = adu[0]; out[1] = adu[1];                 // transaction id
      out[2] = 0; out[3] = 0;                           // protocol
      out[4] = (res.length + 1) >> 8; out[5] = (res.length + 1) & 0xFF;
      out[6] = adu[6];                                  // unit id (qualquer um é aceito no TCP)
      out.set(res, 7);
      return out;
    }
  }

  // ------------------------------------------------------------------ montagem de quadros RTU
  /**
   * Junta bytes vindos da serial em quadros RTU. Em vez de depender do
   * silêncio de 3,5 caracteres (impreciso no navegador e sem sentido numa
   * porta virtual), calcula o tamanho esperado pela função e confere o CRC.
   * Se o CRC falhar, descarta um byte e tenta ressincronizar.
   */
  class RtuFramer {
    constructor(onFrame) { this.buf = new Uint8Array(0); this.onFrame = onFrame; this.crcErrors = 0; }

    push(chunk) {
      const nb = new Uint8Array(this.buf.length + chunk.length);
      nb.set(this.buf); nb.set(chunk, this.buf.length);
      this.buf = nb;
      this.drain();
    }

    reset() { this.buf = new Uint8Array(0); }

    expectedLength(b) {
      if (b.length < 2) return 0;
      const fc = b[1];
      if (fc >= 1 && fc <= 6) return 8;
      if (fc === 15 || fc === 16) return b.length < 7 ? 0 : 9 + b[6];
      return -1; // função desconhecida: não dá para saber o tamanho
    }

    drain() {
      while (this.buf.length >= 4) {
        const need = this.expectedLength(this.buf);
        if (need === 0) return;
        if (need < 0) {
          // função não suportada: responde exceção se o quadro de 4 bytes (endereço, função, CRC) fechar
          if (crc16(this.buf, 0, 2) === (this.buf[2] | (this.buf[3] << 8))) {
            this.emit(this.buf.slice(0, 4)); continue;
          }
          this.buf = this.buf.slice(1); this.crcErrors++; continue;
        }
        if (this.buf.length < need) return;
        const frame = this.buf.slice(0, need);
        const crc = crc16(frame, 0, need - 2);
        if (crc === (frame[need - 2] | (frame[need - 1] << 8))) this.emit(frame);
        else { this.buf = this.buf.slice(1); this.crcErrors++; }
      }
    }

    emit(frame) {
      this.buf = this.buf.slice(frame.length);
      this.onFrame(frame);
    }
  }

  /** Helpers para montar pedidos (usados pelos testes e pelo mestre de teste). */
  function rtuRequest(unit, pdu) {
    const out = new Uint8Array(pdu.length + 3);
    out[0] = unit; out.set(pdu, 1);
    const crc = crc16(out, 0, out.length - 2);
    out[out.length - 2] = crc & 0xFF; out[out.length - 1] = crc >> 8;
    return out;
  }
  function pdu(fc, ...words) {
    const out = [fc];
    for (const w of words) out.push((w >> 8) & 0xFF, w & 0xFF);
    return Uint8Array.from(out);
  }

  const api = { ModbusSlave, RtuFramer, crc16, resolve, modbusRefOf, rtuRequest, pdu, MAP, EX, FC_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PLC = root.PLC || {};
  root.PLC.Modbus = api;
})(typeof window !== 'undefined' ? window : globalThis);
