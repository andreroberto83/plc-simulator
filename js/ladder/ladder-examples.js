/* Programas de exemplo, um ou mais por cena. */
(function (root) {
  'use strict';
  const M = root.PLC.Model;

  const I = (type, props) => Object.assign(M.createInstr(type), props);
  const NO = op => I('NO', { op });
  const NC = op => I('NC', { op });
  const S = (...items) => ({ type: 'series', items });
  const OR = (...branches) => ({ type: 'parallel', branches: branches.map(b => Array.isArray(b) ? S(...b) : S(b)) });
  function R(comment, logic, outputs) { const r = M.newRung(); r.comment = comment; r.logic.items = logic; r.outputs = outputs; return r; }

  function project(name, sceneId, rungs) {
    const p = M.newProject();
    p.name = name; p.sceneId = sceneId; p.rungs = rungs;
    const scene = root.PLC.Scenes.get(sceneId);
    for (const [addr, sym, comment] of scene.io.inputs.concat(scene.io.outputs)) p.symbols[addr] = { name: sym, comment };
    return p;
  }

  const EXAMPLES = [
    {
      id: 'basico', sceneId: 'painel', name: 'Painel — lógica básica',
      build: () => project('Lógica básica', 'painel', [
        R('Botão NA acende L0 enquanto pressionado', [NO('I0.0')], [I('COIL', { op: 'Q0.0' })]),
        R('Função E: CH1 e CH2 ligadas acendem L1', [NO('I0.5'), NO('I0.6')], [I('COIL', { op: 'Q0.1' })]),
        R('Função OU: CH1 ou CH3 acendem L2', [OR(NO('I0.5'), NO('I0.7'))], [I('COIL', { op: 'Q0.2' })]),
        R('Botão NF (1 em repouso): L4 fica acesa até apertar', [NO('I0.4')], [I('COIL', { op: 'Q0.4' })]),
        R('Comparação: potenciômetro acima de 500 acende L6', [I('CMP', { a: 'IW0', cmp: '>', b: '500' })], [I('COIL', { op: 'Q0.6' })]),
        R('Set/Reset: B2 liga L7 e retém, B3 desliga', [NO('I0.2')], [I('SET', { op: 'Q0.7' })]),
        R('', [NO('I0.3')], [I('RST', { op: 'Q0.7' })]),
      ]),
    },
    {
      id: 'pisca', sceneId: 'painel', name: 'Painel — pisca-pisca com TON',
      build: () => project('Pisca-pisca', 'painel', [
        R('T0 conta o tempo apagado; T1.DN reinicia o ciclo', [NO('I0.5'), NC('T1.DN')], [I('TON', { op: 'T0', pre: 500 })]),
        R('T1 conta o tempo aceso', [NO('T0.DN')], [I('TON', { op: 'T1', pre: 500 })]),
        R('L0 acende na segunda metade do ciclo', [NO('T0.DN')], [I('COIL', { op: 'Q0.0' })]),
        R('Retardo na desenergização: L2 apaga 2 s depois de soltar B2', [NO('I0.2')], [I('TOF', { op: 'T2', pre: 2000 })]),
        R('', [NO('T2.DN')], [I('COIL', { op: 'Q0.2' })]),
      ]),
    },
    {
      id: 'contador', sceneId: 'painel', name: 'Painel — contador',
      build: () => project('Contador', 'painel', [
        R('Cada toque em B0 soma 1', [NO('I0.0')], [I('CTU', { op: 'C0', pre: 5 })]),
        R('Cada toque em B1 subtrai 1', [NO('I0.1')], [I('CTD', { op: 'C0', pre: 5 })]),
        R('B2 zera', [NO('I0.2')], [I('RES', { op: 'C0' })]),
        R('Chegou a 5: acende L4', [NO('C0.DN')], [I('COIL', { op: 'Q0.4' })]),
      ]),
    },
    {
      id: 'partida', sceneId: 'motor', name: 'Motor — partida direta com selo',
      build: () => project('Partida direta', 'motor', [
        R('Selo: K1 mantém-se ligado depois de soltar S1. S0 e F1 são NF no campo → contato NA aqui',
          [OR(NO('S1_Liga'), NO('K1')), NO('S0_Desliga'), NO('F1_Termico')], [I('COIL', { op: 'K1' })]),
        R('Sinaleira de motor ligado', [NO('K1')], [I('COIL', { op: 'H1_Ligado' })]),
        R('Sinaleira de falha: F1 abriu', [NC('F1_Termico')], [I('COIL', { op: 'H2_Falha' })]),
      ]),
    },
    {
      id: 'nivel', sceneId: 'tanque', name: 'Tanque — controle com histerese',
      build: () => project('Controle de nível', 'tanque', [
        R('Modo automático com selo', [OR(NO('S1_Auto'), NO('M0.0')), NO('S0_Para')], [I('COIL', { op: 'M0.0' })]),
        R('Liga a bomba quando o nível cai abaixo de LSL', [NO('M0.0'), NC('LSL')], [I('SET', { op: 'P1_Bomba' })]),
        R('Desliga ao atingir LSH ou ao sair do automático', [OR(NO('LSH'), NC('M0.0'))], [I('RST', { op: 'P1_Bomba' })]),
        R('Sinaleira de automático', [NO('M0.0')], [I('COIL', { op: 'H1_Auto' })]),
        R('Alarme de nível muito alto pelo transmissor (> 95%)', [I('CMP', { a: 'LT_Nivel', cmp: '>', b: '950' })], [I('COIL', { op: 'H2_Alarme' })]),
      ]),
    },
    {
      id: 'lote', sceneId: 'esteira', name: 'Esteira — lote de 5 caixas',
      build: () => project('Lote de caixas', 'esteira', [
        R('Esteira com selo; para sozinha quando o lote completa',
          [OR(NO('S1_Liga'), NO('M1_Esteira')), NO('S0_Desliga'), NC('C0.DN')], [I('COIL', { op: 'M1_Esteira' }), I('COIL', { op: 'H2_Rodando' })]),
        R('Conta cada caixa que passa pelo sensor', [NO('B1_Sensor')], [I('CTU', { op: 'C0', pre: 5 })]),
        R('Lote completo', [NO('C0.DN')], [I('COIL', { op: 'H1_Lote' })]),
        R('Reset do lote', [NO('S2_Reset')], [I('RES', { op: 'C0' })]),
      ]),
    },
  ];

  root.PLC = root.PLC || {};
  root.PLC.Examples = EXAMPLES;
})(typeof window !== 'undefined' ? window : globalThis);
