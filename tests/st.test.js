// Testes do Texto Estruturado. Rodar com:  node tests/st.test.js
'use strict';
const path = require('path');
const assert = require('assert');
for (const f of ['core/addresses.js', 'core/model.js', 'core/engine.js', 'st/st.js']) require(path.join(__dirname, '..', 'js', f));
const { ST, Engine, Model } = globalThis.PLC;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** Cria um CLP rodando o programa ST. */
function plc(src) {
  const p = Model.newProject();
  p.language = 'ST'; p.st = src;
  const e = new Engine(); e.setProject(p);
  const c = e.compile();
  if (c.errors.length) throw new Error('Erro de compilação: ' + c.errors.map(x => `L${x.line}: ${x.msg}`).join(' | '));
  assert.ok(e.start(), 'start falhou: ' + JSON.stringify(e.fault));
  return e;
}
function errorsOf(src) { return ST.compile(src).errors; }
function expectError(src, re) {
  const errs = errorsOf(src);
  assert.ok(errs.length, 'era esperado erro');
  assert.ok(errs.some(e => re.test(e.msg)), 'mensagens: ' + errs.map(e => e.msg).join(' | '));
  return errs;
}
const out = (e, k) => e.getOutput(k);

console.log('Léxico e sintaxe');
test('literais de tempo, bases numéricas e comentários', () => {
  const t = ST.lex('T#1m30s T#1.5s TIME#250ms 16#FF 2#1010 1_000 3.5E2 (* c *) // x\n%IX0.3 %MW2');
  assert.deepStrictEqual(t.slice(0, 9).map(x => x.v), [90000, 1500, 250, 255, 10, 1000, 350, 'I0.3', 'MW2']);
});
test('dígito inválido para a base é erro', () => {
  expectError('VAR i : INT; END_VAR\ni := 2#102;', /base 2/);
  expectError('VAR i : INT; END_VAR\ni := 8#9;', /base 8/);
  assert.strictEqual(errorsOf('VAR i : INT; END_VAR\ni := 16#7F_FF;').length, 0);
});
test('erro de ; faltando aponta a linha certa', () => {
  const errs = errorsOf('VAR a : BOOL; END_VAR\na := TRUE\na := FALSE;');
  assert.strictEqual(errs[0].line, 2);
  assert.ok(/Falta ";"/.test(errs[0].msg));
});
test('"=" no lugar de ":=" tem mensagem clara', () => {
  expectError('VAR a : BOOL; END_VAR\na = TRUE;', /Para atribuir use ":="/);
});
test('END_IF faltando', () => {
  expectError('VAR a : BOOL; END_VAR\nIF a THEN a := FALSE;\n', /Falta END_IF/);
});
test('PROGRAM ... END_PROGRAM opcional e case-insensitive', () => {
  const e = plc('program Teste\nvar x at %qx0.0 : bool; end_var\nX := true;\nend_program');
  e.scan(10);
  assert.strictEqual(out(e, 'Q0.0'), 1);
});

console.log('Tipos (verificação da norma)');
test('não declarado', () => { expectError('y := 1;', /não foi declarado/); });
test('BOOL não recebe inteiro', () => { expectError('VAR b : BOOL; END_VAR\nb := 1;', /Não é possível atribuir inteiro a uma variável BOOL/); });
test('INT não recebe REAL sem conversão (com dica)', () => { expectError('VAR i : INT; END_VAR\ni := 2.5;', /REAL_TO_INT/); });
test('REAL recebe INT implicitamente', () => { assert.strictEqual(errorsOf('VAR i : INT; r : REAL; END_VAR\nr := i;').length, 0); });
test('TIME não mistura com inteiro', () => { expectError('VAR t : TIME; END_VAR\nt := 1000;', /T#/); });
test('entrada é somente leitura', () => { expectError('VAR s AT %IX0.0 : BOOL; END_VAR\ns := TRUE;', /somente leitura/); });
test('AT em bit exige BOOL', () => { expectError('VAR s AT %IX0.0 : INT; END_VAR', /deve ser BOOL/); });
test('condição do IF deve ser BOOL', () => { expectError('VAR i : INT; END_VAR\nIF i THEN i := 0; END_IF;', /deve ser BOOL/); });
test('CONSTANT não pode ser alterada', () => { expectError('VAR CONSTANT K : INT := 5; END_VAR\nK := 3;', /CONSTANT/); });
test('FB inexistente / campo errado / chamada em expressão', () => {
  expectError('VAR t : TON; b : BOOL; END_VAR\nt(IN := TRUE, PT := T#1s);\nb := t.DN;', /não tem o campo DN/);
  expectError('VAR t : TON; b : BOOL; END_VAR\nb := t(IN := TRUE);', /não pode ser usado em expressão/);
  expectError('VAR t : TON; END_VAR\nt(IN := TRUE, PT := 1000);', /PT de TON espera TIME/);
});
test('MIN/MAX/LIMIT não misturam TIME com número', () => {
  expectError('VAR d : DINT; END_VAR\nd := MIN(T#1s, 5);', /só números ou só TIME/);
  expectError('VAR t : TIME; END_VAR\nt := LIMIT(T#0s, t, 100);', /só números ou só TIME/);
  assert.strictEqual(errorsOf('VAR t : TIME; END_VAR\nt := MAX(t, T#2s);').length, 0);
});
test('EXIT fora de laço', () => { expectError('EXIT;', /EXIT só pode/); });

console.log('Execução');
test('partida com selo', () => {
  const e = plc(`
VAR
  Liga AT %IX0.0 : BOOL;
  Desliga AT %IX0.1 : BOOL; (* NF *)
  Motor AT %QX0.0 : BOOL;
END_VAR
Motor := (Liga OR Motor) AND Desliga;`);
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(out(e, 'Q0.0'), 0);
  e.setInput('I0.0', 1); e.scan(10); e.setInput('I0.0', 0); e.scan(10);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.setInput('I0.1', 0); e.scan(10);
  assert.strictEqual(out(e, 'Q0.0'), 0);
});
test('aritmética inteira, divisão truncada, MOD, estouro de INT', () => {
  const e = plc(`VAR a : INT; b : INT; c : INT; r : REAL; big : INT := 32767; END_VAR
a := 7 / 2; b := -7 MOD 3; c := big + 1; r := 7 / 2.0;
%MW0 := a; %MW1 := b; %MW2 := c;`);
  e.scan(10);
  assert.strictEqual(e.words.MW0, 3); assert.strictEqual(e.words.MW1, -1); assert.strictEqual(e.words.MW2, -32768);
  assert.strictEqual(e.stProg.watch('r'), '3.5');
});
test('IF / ELSIF / ELSE e CASE com faixas', () => {
  const e = plc(`VAR n AT %IW0 : INT; q1 AT %QX0.0 : BOOL; q2 AT %QX0.1 : BOOL; q3 AT %QX0.2 : BOOL; faixa : INT; END_VAR
IF n > 800 THEN q1 := TRUE; q2 := FALSE;
ELSIF n > 200 THEN q1 := FALSE; q2 := TRUE;
ELSE q1 := FALSE; q2 := FALSE;
END_IF;
CASE n OF
  0: faixa := 0;
  1..99, 100: faixa := 1;
ELSE faixa := 9;
END_CASE;
q3 := faixa = 1;`);
  e.setInput('IW0', 900); e.scan(10);
  assert.deepStrictEqual([out(e, 'Q0.0'), out(e, 'Q0.1'), out(e, 'Q0.2')], [1, 0, 0]);
  e.setInput('IW0', 50); e.scan(10);
  assert.deepStrictEqual([out(e, 'Q0.0'), out(e, 'Q0.1'), out(e, 'Q0.2')], [0, 0, 1]);
  e.setInput('IW0', 300); e.scan(10);
  assert.deepStrictEqual([out(e, 'Q0.0'), out(e, 'Q0.1'), out(e, 'Q0.2')], [0, 1, 0]);
});
test('FOR com ARRAY, WHILE, REPEAT e EXIT', () => {
  const e = plc(`VAR v : ARRAY[1..5] OF INT := [10, 20, 30, 40, 50]; i : INT; soma : DINT; k : INT; END_VAR
soma := 0;
FOR i := 1 TO 5 DO soma := soma + v[i]; END_FOR;
%MW0 := DINT_TO_INT(soma);
k := 0;
WHILE TRUE DO k := k + 1; IF k >= 7 THEN EXIT; END_IF; END_WHILE;
%MW1 := k;
REPEAT k := k - 2; UNTIL k < 0 END_REPEAT;
%MW2 := k;
FOR i := 10 TO 1 BY -3 DO %MW3 := i; END_FOR;`);
  e.scan(10);
  assert.strictEqual(e.words.MW0, 150); assert.strictEqual(e.words.MW1, 7); assert.strictEqual(e.words.MW2, -1); assert.strictEqual(e.words.MW3, 1);
});
test('índice fora do ARRAY leva a STOP com mensagem', () => {
  const e = plc('VAR v : ARRAY[0..3] OF INT; i : INT := 4; END_VAR\nv[i] := 1;');
  e.scan(10);
  assert.strictEqual(e.running, false);
  assert.ok(/fora dos limites/.test(e.fault.msg));
});
test('watchdog em laço infinito', () => {
  const e = plc('VAR i : INT; END_VAR\nWHILE TRUE DO i := i + 1; END_WHILE;');
  e.scan(10);
  assert.strictEqual(e.running, false);
  assert.ok(/Watchdog/.test(e.fault.msg));
});
test('divisão por zero leva a STOP', () => {
  const e = plc('VAR a : INT; b : INT; END_VAR\na := 10 / b;');
  e.scan(10);
  assert.ok(/Divisão por zero/.test(e.fault.msg));
});
test('funções: LIMIT, MAX, SEL, conversões, ABS, SQRT', () => {
  const e = plc(`VAR r : REAL; END_VAR
%MW0 := LIMIT(0, 1500, 1000);
%MW1 := MAX(3, 9, 4);
%MW2 := SEL(TRUE, 1, 2);
%MW3 := REAL_TO_INT(2.5 * 3.0);
%MW4 := ABS(-12);
r := SQRT(16.0);
%MW5 := REAL_TO_INT(r);
%MW6 := DINT_TO_INT(TIME_TO_DINT(T#1s500ms));`);
  e.scan(10);
  assert.deepStrictEqual(['MW0', 'MW1', 'MW2', 'MW3', 'MW4', 'MW5', 'MW6'].map(k => e.words[k]), [1000, 9, 2, 8, 12, 4, 1500]);
});

test('REAL_TO_INT arredonda .5 para longe do zero (simétrico)', () => {
  const e = plc('%MW0 := REAL_TO_INT(2.5); %MW1 := REAL_TO_INT(-2.5); %MW2 := REAL_TO_INT(-1.5); %MW3 := REAL_TO_INT(-1.4);');
  e.scan(10);
  assert.deepStrictEqual(['MW0', 'MW1', 'MW2', 'MW3'].map(k => e.words[k]), [3, -3, -2, -1]);
});
test('STOP→RUN refaz valores iniciais que dependem de outra variável', () => {
  const e = plc('VAR a : INT := 5; b : INT := a; END_VAR\na := a + 1;');
  for (let i = 0; i < 10; i++) e.scan(10);
  e.stop(); assert.ok(e.start());
  assert.strictEqual(e.stProg.watch('a'), '5');
  assert.strictEqual(e.stProg.watch('b'), '5');
});

console.log('Blocos de função IEC');
test('TON (Q e ET)', () => {
  const e = plc(`VAR b AT %IX0.0 : BOOL; t : TON; END_VAR
t(IN := b, PT := T#1s);
%QX0.0 := t.Q;`);
  e.setInput('I0.0', 1);
  for (let i = 0; i < 10; i++) e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 0);
  assert.strictEqual(e.stProg.watch('t.ET'), 'T#900ms');
  e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 0);
  assert.strictEqual(e.stProg.watch('t.ET'), 'T#0ms');
});
test('TOF', () => {
  const e = plc('VAR b AT %IX0.0 : BOOL; t : TOF; END_VAR\nt(IN := b, PT := T#300ms, Q => %QX0.0);');
  e.setInput('I0.0', 1); e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(100); e.scan(100); e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 0);
});
test('TP ignora a entrada durante o pulso', () => {
  const e = plc('VAR b AT %IX0.0 : BOOL; p : TP; END_VAR\np(IN := b, PT := T#200ms);\n%QX0.0 := p.Q;');
  e.setInput('I0.0', 1); e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.setInput('I0.0', 0); e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 1);
  e.scan(100);
  assert.strictEqual(out(e, 'Q0.0'), 0);
});
test('CTU com reset, R_TRIG, CTUD', () => {
  const e = plc(`VAR b AT %IX0.0 : BOOL; r AT %IX0.1 : BOOL; c : CTU; ud : CTUD; e : R_TRIG; n : INT; END_VAR
c(CU := b, R := r, PV := 3);
%QX0.0 := c.Q;
e(CLK := b);
IF e.Q THEN n := n + 1; END_IF;
ud(CU := b, CD := r, PV := 2);`);
  const pulse = () => { e.setInput('I0.0', 1); e.scan(10); e.scan(10); e.setInput('I0.0', 0); e.scan(10); };
  pulse(); pulse();
  assert.strictEqual(out(e, 'Q0.0'), 0);
  pulse();
  assert.strictEqual(out(e, 'Q0.0'), 1);
  assert.strictEqual(e.stProg.watch('n'), '3');
  assert.strictEqual(e.stProg.watch('ud.CV'), '3');
  e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(e.stProg.watch('c.CV'), '0');
  assert.strictEqual(e.stProg.watch('ud.CV'), '2');
});
test('SR e RS (prioridade)', () => {
  const e = plc(`VAR s AT %IX0.0 : BOOL; r AT %IX0.1 : BOOL; a : SR; b : RS; END_VAR
a(S1 := s, R := r); b(S := s, R1 := r);
%QX0.0 := a.Q1; %QX0.1 := b.Q1;`);
  e.setInput('I0.0', 1); e.setInput('I0.1', 1); e.scan(10);
  assert.strictEqual(out(e, 'Q0.0'), 1, 'SR: set domina');
  assert.strictEqual(out(e, 'Q0.1'), 0, 'RS: reset domina');
});
test('pisca-pisca com dois TON', () => {
  const e = plc(`VAR t1, t2 : TON; lamp AT %QX0.0 : BOOL; END_VAR
t1(IN := NOT t2.Q, PT := T#200ms);
t2(IN := t1.Q, PT := T#200ms);
lamp := t1.Q;`);
  const seq = [];
  for (let i = 0; i < 14; i++) { e.scan(100); seq.push(out(e, 'Q0.0')); }
  assert.ok(/0+1+0+1+/.test(seq.join('')), seq.join(''));
});

console.log('Monitoração e troca online');
test('linhas executadas e referências por linha', () => {
  const e = plc(`VAR a AT %IX0.0 : BOOL; x : INT; END_VAR
IF a THEN
  x := 1;
ELSE
  x := 2;
END_IF;`);
  e.scan(10);
  assert.ok(e.stProg.executed.has(5) && !e.stProg.executed.has(3));
  assert.deepStrictEqual(e.stProg.lineRefs[3], ['x']);
});
test('troca online mantém valores', () => {
  const p = Model.newProject(); p.language = 'ST';
  p.st = 'VAR n : INT; END_VAR\nn := n + 1;';
  const e = new Engine(); e.setProject(p); e.start();
  e.scan(10); e.scan(10);
  p.st = 'VAR n : INT; m : INT; END_VAR\nn := n + 10; m := n;';
  e.markDirty(); e.scan(10);
  assert.strictEqual(e.stProg.watch('m'), '12');
});
test('código com erro durante RUN não derruba o programa em execução', () => {
  const p = Model.newProject(); p.language = 'ST';
  p.st = 'VAR n : INT; END_VAR\nn := n + 1;';
  const e = new Engine(); e.setProject(p); e.start(); e.scan(10);
  p.st = 'VAR n : INT; END_VAR\nn := n + ;';
  e.markDirty(); e.scan(10);
  assert.strictEqual(e.running, true);
  assert.strictEqual(e.stProg.watch('n'), '2');
  assert.ok(e.compiled.errors.length > 0);
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
