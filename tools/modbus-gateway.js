#!/usr/bin/env node
/*
 * Gateway Modbus TCP <-> Simulador de CLP (navegador)
 *
 * O navegador não consegue escutar uma porta TCP. Este programa faz isso por
 * ele: aceita mestres Modbus TCP (Node-RED, SCADA, outro software) e repassa
 * cada pedido para a página do simulador por WebSocket; a página, que é o
 * escravo, responde e o gateway devolve a resposta ao mestre.
 *
 * Sem dependências: só Node.js (16 ou mais novo).
 *
 *   node tools/modbus-gateway.js                 # TCP 502, WebSocket 8502, só nesta máquina
 *   node tools/modbus-gateway.js --port 5020     # outra porta TCP
 *   node tools/modbus-gateway.js --host 0.0.0.0  # aceita mestres de outras máquinas da rede
 *   node tools/modbus-gateway.js --timeout 1000 --verbose
 *
 * Se a página não estiver conectada (ou não responder a tempo), o mestre
 * recebe a exceção Modbus 0x0B (gateway: dispositivo não respondeu).
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');

// ------------------------------------------------------------------ argumentos
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
if (args.includes('--help') || args.includes('-h')) {
  console.log('Uso: node tools/modbus-gateway.js [--port 502] [--host 127.0.0.1] [--ws-port 8502] [--timeout 1000] [--verbose]');
  process.exit(0);
}
const TCP_PORT = Number(opt('port', 502));
const TCP_HOST = opt('host', '127.0.0.1');
const WS_PORT = Number(opt('ws-port', 8502));
const TIMEOUT = Number(opt('timeout', 1000));
const VERBOSE = args.includes('--verbose');

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);

// ------------------------------------------------------------------ WebSocket (servidor mínimo, RFC 6455)
let page = null;           // socket da página do simulador (só uma por vez)
let pageBuf = Buffer.alloc(0);

function wsSend(sock, data, opcode) {
  if (!sock || sock.destroyed) return;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let head;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  sock.write(Buffer.concat([head, payload]));
}
const wsBinary = (sock, buf) => wsSend(sock, buf, 0x2);
const wsText = (sock, str) => wsSend(sock, Buffer.from(str, 'utf8'), 0x1);

/** Extrai quadros WebSocket completos do buffer. */
function wsParse(onMessage, sock) {
  while (pageBuf.length >= 2) {
    const b0 = pageBuf[0], b1 = pageBuf[1];
    const opcode = b0 & 0x0F, masked = b1 & 0x80;
    let len = b1 & 0x7F, off = 2;
    if (len === 126) { if (pageBuf.length < 4) return; len = pageBuf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (pageBuf.length < 10) return; len = Number(pageBuf.readBigUInt64BE(2)); off = 10; }
    const maskOff = off;
    if (masked) off += 4;
    if (pageBuf.length < off + len) return;
    let payload = pageBuf.subarray(off, off + len);
    if (masked) {
      const mask = pageBuf.subarray(maskOff, maskOff + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i & 3]));
    }
    pageBuf = pageBuf.subarray(off + len);
    if (opcode === 0x8) { wsSend(sock, Buffer.alloc(0), 0x8); sock.end(); return; }   // close
    if (opcode === 0x9) { wsSend(sock, payload, 0xA); continue; }                     // ping -> pong
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload, opcode);
  }
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Gateway Modbus do Simulador de CLP\nTCP ${TCP_HOST}:${TCP_PORT} · página ${page ? 'conectada' : 'desconectada'} · mestres ${masters.size}\n`);
});

httpServer.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  if (page) { log('Nova página conectou; a anterior foi desconectada.'); page.destroy(); }
  page = sock;
  pageBuf = Buffer.alloc(0);
  log('Página do simulador conectada.');
  sendStatus();
  sock.on('data', d => {
    if (sock !== page) return;
    pageBuf = Buffer.concat([pageBuf, d]);
    wsParse(onPageMessage, sock);
  });
  const gone = () => {
    if (page !== sock) return;
    page = null;
    log('Página do simulador desconectou. Os mestres vão receber a exceção 0x0B até ela voltar.');
    for (const [k, p] of pending) { clearTimeout(p.timer); replyException(p.conn, p.adu); pending.delete(k); }
  };
  sock.on('close', gone);
  sock.on('error', gone);
});

function sendStatus() { if (page) wsText(page, JSON.stringify({ type: 'status', masters: masters.size, tcpPort: TCP_PORT })); }

// ------------------------------------------------------------------ Modbus TCP (mestres)
const masters = new Map();   // id -> {sock, buf}
const pending = new Map();   // "id:tid" -> {conn, adu, timer}
let nextId = 1;

function replyException(conn, adu) {
  if (!conn || conn.sock.destroyed) return;
  const out = Buffer.alloc(9);
  adu.copy(out, 0, 0, 4);        // transaction + protocol
  out.writeUInt16BE(3, 4);       // length
  out[6] = adu[6];               // unit
  out[7] = adu[7] | 0x80;        // função com bit de erro
  out[8] = 0x0B;                 // gateway target device failed to respond
  conn.sock.write(out);
}

function onPageMessage(payload, opcode) {
  if (opcode !== 0x2 || payload.length < 3) return;
  const id = payload.readUInt16BE(0);
  const adu = payload.subarray(2);
  const conn = masters.get(id);
  const key = `${id}:${adu.readUInt16BE(0)}`;
  const p = pending.get(key);
  if (!p) return;                 // chegou tarde demais (já respondemos 0x0B)
  clearTimeout(p.timer);
  pending.delete(key);
  if (conn && !conn.sock.destroyed) conn.sock.write(adu);
  if (VERBOSE) log(`← mestre #${id} tid ${adu.readUInt16BE(0)} função ${adu[7]}${adu[7] & 0x80 ? ' EXCEÇÃO ' + adu[8] : ''}`);
}

function onAdu(conn, adu) {
  const tid = adu.readUInt16BE(0);
  if (VERBOSE) log(`→ mestre #${conn.id} tid ${tid} unit ${adu[6]} função ${adu[7]}`);
  if (!page) { replyException(conn, adu); return; }
  const key = `${conn.id}:${tid}`;
  const frame = Buffer.alloc(2 + adu.length);
  frame.writeUInt16BE(conn.id, 0);
  adu.copy(frame, 2);
  const timer = setTimeout(() => { pending.delete(key); replyException(conn, adu); if (VERBOSE) log(`  sem resposta da página (tid ${tid})`); }, TIMEOUT);
  pending.set(key, { conn, adu: Buffer.from(adu), timer });
  wsBinary(page, frame);
}

const tcpServer = net.createServer(sock => {
  const conn = { id: nextId++ & 0xFFFF, sock, buf: Buffer.alloc(0) };
  if (conn.id === 0) conn.id = nextId++;
  masters.set(conn.id, conn);
  sock.setNoDelay(true);
  log(`Mestre #${conn.id} conectou de ${sock.remoteAddress}:${sock.remotePort}`);
  sendStatus();
  sock.on('data', d => {
    conn.buf = Buffer.concat([conn.buf, d]);
    while (conn.buf.length >= 7) {
      const len = conn.buf.readUInt16BE(4);
      if (conn.buf.readUInt16BE(2) !== 0 || len < 2 || len > 254) {   // não é Modbus TCP: descarta
        log(`Mestre #${conn.id} enviou dados que não são Modbus TCP; conexão encerrada.`);
        sock.destroy(); return;
      }
      if (conn.buf.length < 6 + len) break;
      const adu = conn.buf.subarray(0, 6 + len);
      conn.buf = conn.buf.subarray(6 + len);
      onAdu(conn, adu);
    }
  });
  const bye = () => {
    if (!masters.has(conn.id)) return;
    masters.delete(conn.id);
    log(`Mestre #${conn.id} desconectou.`);
    sendStatus();
  };
  sock.on('close', bye);
  sock.on('error', bye);
});

function listenError(what, port) {
  return e => {
    if (e.code === 'EADDRINUSE') console.error(`\nA porta ${port} (${what}) já está em uso. Outro gateway ou simulador Modbus aberto? Use --${what === 'Modbus TCP' ? 'port' : 'ws-port'} <outra>.`);
    else if (e.code === 'EACCES') console.error(`\nSem permissão para a porta ${port} (${what}). No Linux/macOS portas < 1024 exigem administrador: use --port 5020.`);
    else console.error(e);
    process.exit(1);
  };
}

tcpServer.on('error', listenError('Modbus TCP', TCP_PORT));
httpServer.on('error', listenError('WebSocket', WS_PORT));

httpServer.listen(WS_PORT, '127.0.0.1', () => {
  tcpServer.listen(TCP_PORT, TCP_HOST, () => {
    console.log('Gateway Modbus do Simulador de CLP');
    console.log(`  Mestres Modbus TCP : ${TCP_HOST}:${TCP_PORT}${TCP_HOST === '127.0.0.1' ? '  (só esta máquina; use --host 0.0.0.0 para a rede)' : ''}`);
    console.log(`  Página do simulador: ws://127.0.0.1:${WS_PORT}  (aba Comunicação > Conectar ao gateway)`);
    console.log('  Ctrl+C para sair.\n');
  });
});
