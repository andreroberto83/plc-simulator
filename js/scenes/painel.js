(function (root) {
  'use strict';
  const { register, kit } = root.PLC.Scenes;

  register({
    id: 'painel',
    name: 'Painel de treinamento',
    description: 'Bancada genérica: 5 botões, 3 chaves, 1 potenciômetro e 8 lâmpadas. Bom para os primeiros exercícios de lógica, temporização e contagem.',
    io: {
      inputs: [
        ['I0.0', 'B0', 'Botão NA verde'],
        ['I0.1', 'B1', 'Botão NA verde'],
        ['I0.2', 'B2', 'Botão NA amarelo'],
        ['I0.3', 'B3', 'Botão NA amarelo'],
        ['I0.4', 'B4_NF', 'Botão NF vermelho (1 em repouso)'],
        ['I0.5', 'CH1', 'Chave 1'],
        ['I0.6', 'CH2', 'Chave 2'],
        ['I0.7', 'CH3', 'Chave 3'],
        ['IW0', 'POT', 'Potenciômetro 0–1000'],
      ],
      outputs: [
        ['Q0.0', 'L0', 'Lâmpada verde'], ['Q0.1', 'L1', 'Lâmpada verde'],
        ['Q0.2', 'L2', 'Lâmpada amarela'], ['Q0.3', 'L3', 'Lâmpada amarela'],
        ['Q0.4', 'L4', 'Lâmpada vermelha'], ['Q0.5', 'L5', 'Lâmpada vermelha'],
        ['Q0.6', 'L6', 'Lâmpada azul'], ['Q0.7', 'L7', 'Lâmpada branca'],
      ],
    },
    create(host, api) {
      const r1 = kit.row(host, 'Entradas');
      kit.pushButton(api, r1, { label: 'B0', addr: 'I0.0', color: 'green' });
      kit.pushButton(api, r1, { label: 'B1', addr: 'I0.1', color: 'green' });
      kit.pushButton(api, r1, { label: 'B2', addr: 'I0.2', color: 'yellow' });
      kit.pushButton(api, r1, { label: 'B3', addr: 'I0.3', color: 'yellow' });
      kit.pushButton(api, r1, { label: 'B4', addr: 'I0.4', color: 'red', nc: true });
      const r2 = kit.row(host);
      kit.toggle(api, r2, { label: 'CH1', addr: 'I0.5' });
      kit.toggle(api, r2, { label: 'CH2', addr: 'I0.6' });
      kit.toggle(api, r2, { label: 'CH3', addr: 'I0.7' });
      kit.slider(api, r2, { label: 'Potenciômetro', addr: 'IW0', max: 1000 });
      const r3 = kit.row(host, 'Saídas');
      const colors = ['green', 'green', 'yellow', 'yellow', 'red', 'red', 'blue', 'white'];
      const lamps = colors.map((c, i) => kit.lamp(api, r3, { label: 'L' + i, addr: 'Q0.' + i, color: c }));
      return {
        step() { lamps.forEach(l => l.update()); },
        destroy() {},
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
