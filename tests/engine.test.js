// Testes do motor de execução. Rodar com:  node tests/engine.test.js
'use strict';
const path = require('path');
const assert = require('assert');
require(path.join(__dirname, '..', 'js', 'core', 'addresses.js'));
require(path.join(__dirname, '..', 'js', 'core', 'model.js'));
require(path.join(__dirname, '..', 'js', 'core', 'engine.js'));
const { Addr, Model, Engine } = globalThis.PLC;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function I(type, props) { return Object.assign(Model.createInstr(type), props); }
function series(...items) { return { type: 'series', items }; }
function par(...branches) { return { type: 'parallel', branches: branches.map(b => Array.isArray(b) ? series(...b) : series(b)) }; }
function rung(logicItems, outputs) { const r = Model.newRung(); r.logic.items = logicItems; r.outputs = outputs; return r; }
function project(rungs, symbols) { const p = Model.newProject(); p.rungs = rungs; p.symbols = symbols || {}; return p; }
function run(p) { const e = new Engine(); e.setProject(p); e.start(); return e; }

console.log('Endereços');
test('bits, words, timers, counters', () => {
  assert.strictEqual(Addr.parse('i0.3').key, 'I0.3');
  assert.strictEqual(Addr.parse('I0.8'), null);
  assert.strictEqual(Addr.parse('Q8.0'), null);
  assert.strictEqual(Addr.parse('MW3').kind, 'word');
  assert.strictEqual(Addr.parse('T5.DN').field, 'DN');
  assert.ok(Addr.parse('C2.ACC').isWord);
  assert.strictEqual(Addr.parse('T32'), null);
  assert.strictEqual(Addr.parse('X1'), null);
});
test('símbolos, inclusive com sufixo', () => {
  const s = { 'I0.0': { name: 'BtLiga' }, T3: { name: 'Atraso' } };
  assert.strictEqual(Addr.resolve('btliga', s).key, 'I0.0');
  assert.strictEqual(Addr.resolve('Atraso.DN', s).key, 'T3.DN');
  assert.strictEqual(Addr.resolve('Nada', s), null);
  assert.strictEqual(Addr.symbolOf('T3.ACC', s), 'Atraso.ACC');
});

console.log('Contatos e bobinas');
test('NA liga bobina, NF inverte', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('COIL', { op: 'Q0.0' })]),
    rung([I('NC', { op: 'I0.0' })], [I('COIL', { op: 'Q0.1' })]),
  ]);
  const e = run(p);
  e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 0); assert.strictEqual(e.getOutput('Q0.1'), 1);
  e.setInput('I0.0', 1); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 1); assert.strictEqual(e.getOutput('Q0.1'), 0);
});
test('selo (partida direta com NF físico no desliga)', () => {
  // I0.0 liga (NA), I0.1 desliga (botão NF: em repouso a entrada é 1)
  const p = project([
    rung([par(I('NO', { op: 'I0.0' }), I('NO', { op: 'Q0.0' })), I('NO', { op: 'I0.1' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  e.setInput('I0.1', 1); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
  e.setInput('I0.0', 1); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 1, 'selo deve manter');
  e.setInput('I0.1', 0); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 0, 'desliga deve derrubar');
  e.setInput('I0.1', 1); e.scan(50);
  assert.strictEqual(e.getOutput('Q0.0'), 0, 'não religa sozinho');
});
test('set/reset', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('SET', { op: 'M0.0' })]),
    rung([I('NO', { op: 'I0.1' })], [I('RST', { op: 'M0.0' })]),
    rung([I('NO', { op: 'M0.0' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(10); e.setInput('I0.0', 0); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('borda de subida dura 1 scan', () => {
  const p = project([rung([I('P', { op: 'I0.0' })], [I('COIL', { op: 'Q0.0' })])]);
  const e = run(p);
  e.scan(10);
  e.setInput('I0.0', 1); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('borda de descida', () => {
  const p = project([rung([I('N', { op: 'I0.0' })], [I('COIL', { op: 'Q0.0' })])]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(10); e.scan(10);
  e.setInput('I0.0', 0); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('ramo paralelo com série dentro: (A e B) ou C', () => {
  const p = project([rung([par([I('NO', { op: 'I0.0' }), I('NO', { op: 'I0.1' })], I('NO', { op: 'I0.2' }))], [I('COIL', { op: 'Q0.0' })])]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.0', 0); e.setInput('I0.2', 1); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
});

console.log('Temporizadores');
test('TON', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('TON', { op: 'T0', pre: 1000 })]),
    rung([I('NO', { op: 'T0.DN' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  e.setInput('I0.0', 1);
  for (let i = 0; i < 9; i++) e.scan(100);
  assert.strictEqual(e.peek('T0.ACC'), 900); assert.strictEqual(e.getOutput('Q0.0'), 0); assert.strictEqual(e.peek('T0.TT'), 1);
  e.scan(100); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 1); assert.strictEqual(e.peek('T0.ACC'), 1000);
  e.setInput('I0.0', 0); e.scan(100);
  assert.strictEqual(e.peek('T0.ACC'), 0); assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('TOF', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('TOF', { op: 'T1', pre: 300 })]),
    rung([I('NO', { op: 'T1.DN' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(100); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 1, 'ainda temporizando');
  e.scan(100); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('TP gera pulso fixo', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('TP', { op: 'T2', pre: 200 })]),
    rung([I('NO', { op: 'T2.DN' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(100);
  assert.strictEqual(e.getOutput('Q0.0'), 0, 'pulso termina após 200ms mesmo com entrada desligada');
});
test('pisca-pisca com dois TON', () => {
  const p = project([
    rung([I('NC', { op: 'T1.DN' })], [I('TON', { op: 'T0', pre: 200 })]),
    rung([I('NO', { op: 'T0.DN' })], [I('TON', { op: 'T1', pre: 200 })]),
    rung([I('NO', { op: 'T0.DN' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  const seq = [];
  for (let i = 0; i < 12; i++) { e.scan(100); seq.push(e.getOutput('Q0.0')); }
  assert.ok(seq.includes(1) && seq.lastIndexOf(0) > seq.indexOf(1), 'deve alternar: ' + seq.join(''));
});

console.log('Contadores e comparação');
test('CTU conta bordas, DN no preset, RES zera', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('CTU', { op: 'C0', pre: 3 })]),
    rung([I('NO', { op: 'I0.1' })], [I('RES', { op: 'C0' })]),
    rung([I('NO', { op: 'C0.DN' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = run(p);
  for (let i = 0; i < 3; i++) { e.setInput('I0.0', 1); e.scan(10); e.scan(10); e.setInput('I0.0', 0); e.scan(10); }
  assert.strictEqual(e.peek('C0.ACC'), 3);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(e.peek('C0.ACC'), 0);
  e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});
test('CTD decrementa', () => {
  const p = project([
    rung([I('NO', { op: 'I0.0' })], [I('CTU', { op: 'C1', pre: 0 })]),
    rung([I('NO', { op: 'I0.1' })], [I('CTD', { op: 'C1', pre: 0 })]),
  ]);
  const e = run(p);
  e.setInput('I0.0', 1); e.scan(10); e.setInput('I0.0', 0); e.scan(10);
  e.setInput('I0.0', 1); e.scan(10); e.setInput('I0.0', 0); e.scan(10);
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(e.peek('C1.ACC'), 1);
});
test('comparação com entrada analógica e constante', () => {
  const p = project([
    rung([I('CMP', { a: 'IW0', cmp: '>=', b: '500' })], [I('COIL', { op: 'Q0.0' })]),
    rung([I('CMP', { a: 'IW0', cmp: '<', b: 'IW1' })], [I('COIL', { op: 'Q0.1' })]),
  ]);
  const e = run(p);
  e.setInput('IW0', 499); e.setInput('IW1', 600); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 0); assert.strictEqual(e.getOutput('Q0.1'), 1);
  e.setInput('IW0', 700); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1); assert.strictEqual(e.getOutput('Q0.1'), 0);
});

console.log('Compilação e STOP');
test('erros de operando e aviso de bobina dupla', () => {
  const p = project([
    rung([I('NO', { op: 'X9' })], [I('COIL', { op: 'Q0.0' })]),
    rung([I('NO', { op: 'I0.0' })], [I('COIL', { op: 'I0.1' })]),
    rung([I('NO', { op: 'I0.0' })], [I('COIL', { op: 'Q0.0' })]),
  ]);
  const e = new Engine(); e.setProject(p);
  const c = e.compile();
  assert.strictEqual(c.errors.length, 2);
  assert.ok(c.warnings.some(w => /bobina dupla/.test(w.msg)));
});
test('STOP zera saídas físicas', () => {
  const p = project([rung([], [I('COIL', { op: 'Q0.0' })])]);
  const e = run(p); e.scan(10);
  assert.strictEqual(e.getOutput('Q0.0'), 1);
  e.stop();
  assert.strictEqual(e.getOutput('Q0.0'), 0);
});

console.log('Edição da árvore');
test('inserir em série, paralelo e excluir normaliza', () => {
  const p = Model.newProject();
  const r = p.rungs[0];
  const a = I('NO', { op: 'I0.0' }); const b = I('NO', { op: 'I0.1' }); const c = I('NO', { op: 'I0.2' }); const d = I('NO', { op: 'I0.3' });
  Model.insertCondition(p, { rungId: r.id }, a, 'series');
  Model.insertCondition(p, { id: a.id }, b, 'parallel');       // a || b
  Model.insertCondition(p, { id: a.id }, c, 'series');         // (a c) || b
  Model.insertCondition(p, { id: b.id }, d, 'parallel');       // (a c) || b || d
  assert.strictEqual(r.logic.items.length, 1);
  assert.strictEqual(r.logic.items[0].branches.length, 3);
  assert.strictEqual(r.logic.items[0].branches[0].items.length, 2);
  Model.removeElement(p, b.id); Model.removeElement(p, d.id);  // só (a c)
  assert.deepStrictEqual(r.logic.items.map(x => x.id), [a.id, c.id]);
});
test('validateProject rejeita lixo', () => {
  assert.throws(() => Model.validateProject({}));
  assert.throws(() => Model.validateProject({ rungs: [{ logic: { type: 'series', items: [{ type: 'COIL' }] }, outputs: [] }] }));
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
