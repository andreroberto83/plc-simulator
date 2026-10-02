#!/usr/bin/env node
/*
 * Mestre Modbus TCP de teste (sem dependências). Serve para conferir o gateway
 * e o mapa de endereços antes de montar o fluxo no Node-RED.
 *
 *   node tools/modbus-test-master.js                    # lê tudo uma vez
 *   node tools/modbus-test-master.js --poll 500         # lê a cada 500 ms
 *   node tools/modbus-test-master.js --write-coil 1024=1 --write-reg 1026=750
 *   node tools/modbus-test-master.js --write-real 2048=21.5 --write-dint 2050=100000
 *   node tools/modbus-test-master.js --swap           # 32 bits com palavra baixa primeiro (CDAB)
 *   node tools/modbus-test-master.js --host 192.168.0.10 --port 502 --unit 1
 */
'use strict';
const net = require('net');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const all = n => args.reduce((a, v, i) => (v === '--' + n ? a.concat(args[i + 1]) : a), []);
const HOST = opt('host', '127.0.0.1'), PORT = Number(opt('port', 502)), UNIT = Number(opt('unit', 1));
const POLL = Number(opt('poll', 0));
const SWAP = args.includes('--swap');

/** 32 bits -> dois registradores na ordem configurada (ABCD ou CDAB). */
function to32(value, real) {
  const b = Buffer.alloc(4);
  real ? b.writeFloatBE(value) : b.writeInt32BE(value | 0);
  const hi = b.readUInt16BE(0), lo = b.readUInt16BE(2);
  return SWAP ? [lo, hi] : [hi, lo];
}
function from32(r0, r1, real) {
  const [hi, lo] = SWAP ? [r1, r0] : [r0, r1];
  const b = Buffer.alloc(4);
  b.writeUInt16BE(hi & 0xFFFF, 0); b.writeUInt16BE(lo & 0xFFFF, 2);
  return real ? +b.readFloatBE(0).toPrecision(7) : b.readInt32BE(0);
}
const w16x = (fc, a, regs) => [fc, a >> 8, a & 255, 0, regs.length, regs.length * 2, ...regs.flatMap(r => [(r >> 8) & 255, r & 255])];

let tid = 0;
const waiting = new Map();
const sock = net.connect(PORT, HOST);
let buf = Buffer.alloc(0);
sock.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
    const len = buf.readUInt16BE(4);
    const adu = buf.subarray(0, 6 + len);
    buf = buf.subarray(6 + len);
    const w = waiting.get(adu.readUInt16BE(0));
    if (w) { waiting.delete(adu.readUInt16BE(0)); w(adu.subarray(7)); }
  }
});
sock.on('error', e => { console.error(`Não conectou em ${HOST}:${PORT}: ${e.message}. O gateway está rodando?`); process.exit(1); });

function request(pdu) {
  return new Promise((resolve, reject) => {
    const id = (tid = (tid + 1) & 0xFFFF);
    const head = Buffer.alloc(7);
    head.writeUInt16BE(id, 0); head.writeUInt16BE(0, 2); head.writeUInt16BE(pdu.length + 1, 4); head[6] = UNIT;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('sem resposta')); }, 2000);
    waiting.set(id, r => { clearTimeout(t); r[0] & 0x80 ? reject(new Error(`exceção ${r[1]}${r[1] === 11 ? ' (a página do simulador não está conectada ao gateway)' : r[1] === 2 ? ' (endereço ilegal)' : ''}`)) : resolve(r); });
    sock.write(Buffer.concat([head, Buffer.from(pdu)]));
  });
}
const w16 = (fc, a, b) => [fc, a >> 8, a & 255, b >> 8, b & 255];
const bits = (r, n) => Array.from({ length: n }, (_, i) => (r[2 + (i >> 3)] >> (i & 7)) & 1);
const regs = (r, n) => Array.from({ length: n }, (_, i) => r.readInt16BE(2 + i * 2));

async function once() {
  const out = [];
  const row = async (label, fn) => { try { out.push(`${label.padEnd(34)} ${await fn()}`); } catch (e) { out.push(`${label.padEnd(34)} ERRO: ${e.message}`); } };
  await row('Discrete Inputs 0-7   (%IX0.0-7)', async () => bits(await request(w16(2, 0, 8)), 8).join(' '));
  await row('Coils 0-7             (%QX0.0-7)', async () => bits(await request(w16(1, 0, 8)), 8).join(' '));
  await row('Coils 1024-1031       (%MX0.0-7)', async () => bits(await request(w16(1, 1024, 8)), 8).join(' '));
  await row('Input Registers 0-3   (%IW0-3)', async () => regs(await request(w16(4, 0, 4)), 4).join(' '));
  await row('Holding Registers 0-3 (%QW0-3)', async () => regs(await request(w16(3, 0, 4)), 4).join(' '));
  await row('Holding 1024-1027     (%MW0-3)', async () => regs(await request(w16(3, 1024, 4)), 4).join(' '));
  await row(`Holding 2048-2055     (%MD0-3) ${SWAP ? 'CDAB' : 'ABCD'}`, async () => {
    const r = regs(await request(w16(3, 2048, 8)), 8);
    const out = [];
    for (let i = 0; i < 8; i += 2) out.push(`MD${i / 2}: REAL ${from32(r[i], r[i + 1], true)} | DINT ${from32(r[i], r[i + 1], false)}`);
    return '\n    ' + out.join('\n    ');
  });
  console.log(out.join('\n') + '\n');
}

sock.on('connect', async () => {
  console.log(`Conectado em ${HOST}:${PORT}, unit ${UNIT}\n`);
  for (const w of all('write-coil')) {
    const [a, v] = w.split('=').map(Number);
    try { await request(w16(5, a, v ? 0xFF00 : 0)); console.log(`coil ${a} <- ${v ? 1 : 0}`); } catch (e) { console.log(`coil ${a}: ${e.message}`); }
  }
  for (const w of all('write-reg')) {
    const [a, v] = w.split('=').map(Number);
    try { await request(w16(6, a, v & 0xFFFF)); console.log(`holding ${a} <- ${v}`); } catch (e) { console.log(`holding ${a}: ${e.message}`); }
  }
  for (const [flag, real] of [['write-real', true], ['write-dint', false]]) {
    for (const w of all(flag)) {
      const [a, v] = w.split('=').map(Number);
      try { await request(w16x(16, a, to32(v, real))); console.log(`holding ${a}-${a + 1} <- ${v} (${real ? 'REAL' : 'DINT'}, ${SWAP ? 'CDAB' : 'ABCD'})`); } catch (e) { console.log(`holding ${a}: ${e.message}`); }
    }
  }
  await once();
  if (POLL > 0) setInterval(once, POLL); else sock.end();
});
