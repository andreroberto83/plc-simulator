// Testes do Modbus escravo. Rodar com:  node tests/modbus.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['core/addresses.js', 'core/model.js', 'core/engine.js', 'st/st.js', 'comm/modbus-core.js']) require(path.join(__dirname, '..', 'js', f));
const { Engine, Model, Modbus } = globalThis.PLC;
const { ModbusSlave, RtuFramer, crc16, rtuRequest, pdu } = Modbus;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0')).join(' ');

function plc(src) {
  const p = Model.newProject(); p.language = 'ST'; p.st = src;
  const e = new Engine(); e.setProject(p); e.compile(); e.start();
  return { e, slave: new ModbusSlave(e.commData(), { unitId: 1 }) };
}

console.log('CRC e quadros');
test('CRC16 Modbus do exemplo clássico (01 03 00 00 00 0A -> C5 CD)', () => {
  const f = rtuRequest(1, pdu(3, 0, 10));
  assert.strictEqual(hex(f), '01 03 00 00 00 0a c5 cd');
  assert.strictEqual(crc16(f), 0);
});
test('framer junta pedaços, ignora lixo e ressincroniza', () => {
  const got = [];
  const fr = new RtuFramer(f => got.push(hex(f)));
  const a = rtuRequest(1, pdu(3, 1024, 2)), b = rtuRequest(1, Uint8Array.from([16, 4, 0, 0, 2, 4, 0, 1, 0, 2]));
  fr.push(Uint8Array.of(0x55));             // lixo
  fr.push(a.subarray(0, 3)); fr.push(a.subarray(3));
  fr.push(b.subarray(0, 6)); fr.push(b.subarray(6));
  assert.deepStrictEqual(got, [hex(a), hex(b)]);
  assert.ok(fr.crcErrors >= 1);
});

console.log('Leitura e escrita');
const SRC = `VAR
  B0 AT %IX0.0 : BOOL; B3 AT %IX0.3 : BOOL; POT AT %IW0 : INT;
  L0 AT %QX0.0 : BOOL; L2 AT %QX0.2 : BOOL; Saida AT %QW1 : INT;
  Habilita AT %MX0.1 : BOOL; Setpoint AT %MW2 : INT; Contagem AT %MW5 : INT;
END_VAR
L0 := B0 AND Habilita;
L2 := POT > Setpoint;
Saida := POT - Setpoint;
Contagem := Contagem + 1;`;

test('FC02 discrete inputs e FC04 input registers refletem a cena', () => {
  const { e, slave } = plc(SRC);
  e.setInput('I0.0', 1); e.setInput('I0.3', 1); e.setInput('IW0', 700); e.scan(10);
  assert.strictEqual(hex(slave.handlePdu(pdu(2, 0, 8))), '02 01 09');
  assert.strictEqual(hex(slave.handlePdu(pdu(4, 0, 1))), '04 02 02 bc');
});
test('FC05/FC06 escrevem %MX/%MW e o programa usa no próximo scan', () => {
  const { e, slave } = plc(SRC);
  e.setInput('I0.0', 1); e.setInput('IW0', 700); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
  assert.strictEqual(hex(slave.handlePdu(pdu(5, 1025, 0xFF00))), '05 04 01 ff 00');
  assert.strictEqual(hex(slave.handlePdu(pdu(6, 1026, 500))), '06 04 02 01 f4');
  e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  assert.strictEqual(e.getOutput('Q0.2'), 1);
  assert.strictEqual(hex(slave.handlePdu(pdu(1, 0, 3))), '01 01 05');
});
test('FC03 lê %QW e %MW com sinal (complemento de 2)', () => {
  const { e, slave } = plc(SRC);
  e.setInput('IW0', 100); slave.handlePdu(pdu(6, 1026, 500)); e.scan(10);
  // %QW1 = 100 - 500 = -400 = 0xFE70
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 1, 1))), '03 02 fe 70');
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 1026, 1))), '03 02 01 f4');
});
test('FC15 e FC16 (múltiplos) e escrita negativa', () => {
  const { e, slave } = plc(SRC);
  // coils 1024..1026 = 0,1,1 -> byte 0b110
  assert.strictEqual(hex(slave.handlePdu(Uint8Array.from([15, 4, 0, 0, 3, 1, 6]))), '0f 04 00 00 03');
  assert.strictEqual(e.bits['M0.1'], 1); assert.strictEqual(e.bits['M0.2'], 1); assert.strictEqual(e.bits['M0.0'], 0);
  assert.strictEqual(hex(slave.handlePdu(Uint8Array.from([16, 4, 0, 0, 2, 4, 0xFF, 0xFF, 0, 7]))), '10 04 00 00 02');
  assert.strictEqual(e.words.MW0, -1); assert.strictEqual(e.words.MW1, 7);
});

console.log('Exceções');
test('escrever em saída ou entrada é endereço ilegal (supervisório só escreve %M)', () => {
  const { slave } = plc(SRC);
  assert.strictEqual(hex(slave.handlePdu(pdu(5, 0, 0xFF00))), '85 02');
  assert.strictEqual(hex(slave.handlePdu(pdu(6, 0, 1))), '86 02');
});
test('fora do mapa, quantidade inválida, função desconhecida', () => {
  const { slave } = plc(SRC);
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 8, 1))), '83 02');
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 1024, 200))), '83 03');
  assert.strictEqual(hex(slave.handlePdu(pdu(5, 1024, 0x1234))), '85 03');
  assert.strictEqual(hex(slave.handlePdu(Uint8Array.of(0x2B, 0x0E, 1, 0))), 'ab 01');
});

test('em STOP o mestre lê as saídas zeradas, como a cena', () => {
  const { e, slave } = plc('%QX0.0 := TRUE; %QW0 := 123;');
  e.scan(10);
  assert.strictEqual(hex(slave.handlePdu(pdu(1, 0, 1))), '01 01 01');
  e.stop();
  assert.strictEqual(hex(slave.handlePdu(pdu(1, 0, 1))), '01 01 00');
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 0, 1))), '03 02 00 00');
});
test('palavra de 16 bits: %QW estoura igual ao Modbus e UINT lê 65535', () => {
  const { e, slave } = plc('VAR u AT %MW0 : UINT; x AT %MW1 : INT; END_VAR\n%QW0 := 70000; x := 32767; x := x + 1;');
  slave.handlePdu(pdu(6, 1024, 0xFFFF));
  e.scan(10);
  assert.strictEqual(e.getOutput('QW0'), 4464);
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 0, 1))), '03 02 11 70');
  assert.strictEqual(e.stProg.watch('u'), '65535');
  assert.strictEqual(e.stProg.watch('x'), '-32768');
});
test('AT %MW só aceita INT ou UINT', () => {
  const { ST } = globalThis.PLC;
  assert.ok(ST.compile('VAR d AT %MW0 : DINT; END_VAR').errors.some(e => /16 bits/.test(e.msg)));
  assert.strictEqual(ST.compile('VAR u AT %MW0 : UINT; END_VAR').errors.length, 0);
});

console.log('RTU e TCP');
test('RTU: responde só ao seu ID, broadcast executa sem responder', () => {
  const { e, slave } = plc(SRC);
  slave.unitId = 5;
  assert.strictEqual(slave.handleRtuFrame(rtuRequest(1, pdu(3, 1024, 1))), null);
  const r = slave.handleRtuFrame(rtuRequest(5, pdu(3, 1026, 1)));
  assert.strictEqual(r[0], 5); assert.strictEqual(crc16(r), 0);
  assert.strictEqual(slave.handleRtuFrame(rtuRequest(0, pdu(6, 1030, 42))), null);
  assert.strictEqual(e.words.MW6, 42);
});
test('TCP: MBAP ecoa transaction id e unit id', () => {
  const { slave } = plc(SRC);
  const req = Uint8Array.from([0x12, 0x34, 0, 0, 0, 6, 9, 3, 4, 0, 0, 1]);
  assert.strictEqual(hex(slave.handleTcpAdu(req)), '12 34 00 00 00 05 09 03 02 00 00');
});
test('TCP: MBAP sem PDU (length < 2) é descartado', () => {
  const { slave } = plc(SRC);
  assert.strictEqual(slave.handleTcpAdu(Uint8Array.from([0, 1, 0, 0, 0, 0, 1, 3])), null);
  assert.strictEqual(slave.handleTcpAdu(Uint8Array.from([0, 1, 0, 0, 0, 1, 1, 3])), null);
});
test('modbusRefOf para a tela', () => {
  assert.strictEqual(Modbus.modbusRefOf('M0.1'), 'Coil 1025');
  assert.strictEqual(Modbus.modbusRefOf('MW2'), 'Holding Register 1026');
  assert.strictEqual(Modbus.modbusRefOf('I0.3'), 'Discrete Input 3');
});

console.log('32 bits (%MD): REAL e DINT');
const SRC32 = `VAR
  Temp AT %MD0 : REAL; Total AT %MD1 : DINT; Grande AT %MD2 : UDINT;
  Sp AT %MD3 : REAL; Dobro AT %MD4 : REAL;
END_VAR
Temp := 21.5; Total := 100000; Grande := 4000000000;
Dobro := Sp * 2.0;`;
test('ABCD (palavra alta primeiro): REAL, DINT e UDINT', () => {
  const { e, slave } = plc(SRC32);
  e.scan(10);
  // 21.5 = 0x41AC0000 ; 100000 = 0x000186A0 ; 4e9 = 0xEE6B2800
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 2048, 6))), '03 0c 41 ac 00 00 00 01 86 a0 ee 6b 28 00');
});
test('CDAB (palavra baixa primeiro)', () => {
  const { e, slave } = plc(SRC32);
  slave.wordOrder = 'CDAB';
  e.scan(10);
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 2048, 4))), '03 08 00 00 41 ac 86 a0 00 01');
});
test('FC16 escreve REAL no %MD e o programa usa', () => {
  const { e, slave } = plc(SRC32);
  // 3.25 = 0x40500000 em %MD3 (holding 2054-2055)
  assert.strictEqual(hex(slave.handlePdu(Uint8Array.from([16, 0x08, 0x06, 0, 2, 4, 0x40, 0x50, 0, 0]))), '10 08 06 00 02');
  e.scan(10);
  assert.strictEqual(e.stProg.watch('Sp'), '3.25');
  assert.strictEqual(e.stProg.watch('Dobro'), '6.5');
});
test('FC06 em metade do par (escrita parcial) e CDAB na escrita', () => {
  const { e, slave } = plc(SRC32);
  slave.wordOrder = 'CDAB';
  // CDAB: 2054 = palavra baixa, 2055 = alta -> 0x40500000
  slave.handlePdu(pdu(6, 2055, 0x4050));
  slave.handlePdu(pdu(6, 2054, 0x0000));
  e.scan(10);
  assert.strictEqual(e.stProg.watch('Sp'), '3.25');
});
test('%MD fora do mapa e endereço Modbus exibido', () => {
  const { slave } = plc(SRC32);
  assert.strictEqual(hex(slave.handlePdu(pdu(3, 2080, 1))), '83 02');
  assert.strictEqual(Modbus.modbusRefOf('MD3'), 'Holding Registers 2054–2055');
});
test('AT %MD com tipo errado é recusado', () => {
  const { ST } = globalThis.PLC;
  const errs = ST.compile('VAR x AT %MD0 : INT; END_VAR').errors;
  assert.ok(errs.some(e => /32 bits/.test(e.msg)));
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
