(function (root) {
  'use strict';
  const { register, kit } = root.PLC.Scenes;

  const LSL = 20, LSH = 80;          // posição das boias (%)
  const FILL = 6, DRAIN = 4, USE = 2.5; // %/s

  register({
    id: 'tanque',
    name: 'Controle de nível de tanque',
    description: `Bomba P1 enche o tanque, válvula V1 esvazia. Boias LSL (${LSL}%) e LSH (${LSH}%) ficam em 1 quando cobertas pelo líquido. O transmissor LT envia o nível em IW0 (0–1000 = 0–100%). O consumo é uma perturbação que o CLP não controla.`,
    io: {
      inputs: [
        ['I0.0', 'LSL', `Boia de nível baixo (${LSL}%) — 1 = coberta`],
        ['I0.1', 'LSH', `Boia de nível alto (${LSH}%) — 1 = coberta`],
        ['I0.2', 'S1_Auto', 'Botão liga automático (NA)'],
        ['I0.3', 'S0_Para', 'Botão desliga (NF)'],
        ['IW0', 'LT_Nivel', 'Transmissor de nível 0–1000'],
      ],
      outputs: [
        ['Q0.0', 'P1_Bomba', 'Bomba de enchimento'],
        ['Q0.1', 'V1_Valvula', 'Válvula de saída'],
        ['Q0.2', 'H1_Auto', 'Sinaleira modo automático'],
        ['Q0.3', 'H2_Alarme', 'Sinaleira de alarme'],
      ],
    },
    create(host, api) {
      host.appendChild(kit.svg(`
        <svg viewBox="0 0 420 220" class="scene-drawing">
          <g id="pump" transform="translate(40,190)">
            <circle r="16" class="dev"/><path d="M-6 -8 L10 0 L-6 8 Z" class="dev-t-fill"/>
            <text y="-24" text-anchor="middle" class="dev-t">P1</text>
          </g>
          <path id="pipe-in" class="pipe" d="M56 190 L100 190 L100 30 L160 30 L160 44"/>
          <rect x="130" y="40" width="160" height="160" class="tank"/>
          <clipPath id="tank-clip"><rect x="131" y="41" width="158" height="158"/></clipPath>
          <rect id="liquid" x="131" y="199" width="158" height="0" class="liquid" clip-path="url(#tank-clip)"/>
          <line x1="130" y1="${200 - LSH * 1.6}" x2="118" y2="${200 - LSH * 1.6}" class="tick"/>
          <line x1="130" y1="${200 - LSL * 1.6}" x2="118" y2="${200 - LSL * 1.6}" class="tick"/>
          <circle id="lsh" cx="140" cy="${200 - LSH * 1.6}" r="6" class="float"/>
          <circle id="lsl" cx="140" cy="${200 - LSL * 1.6}" r="6" class="float"/>
          <text x="112" y="${204 - LSH * 1.6}" text-anchor="end" class="lbl">LSH</text>
          <text x="112" y="${204 - LSL * 1.6}" text-anchor="end" class="lbl">LSL</text>
          <text id="pct" x="210" y="125" text-anchor="middle" class="big">0%</text>
          <path id="pipe-out" class="pipe" d="M290 190 L360 190"/>
          <g id="valve" transform="translate(330,190)">
            <path d="M-12 -9 L12 9 L12 -9 L-12 9 Z" class="dev"/>
            <text y="-16" text-anchor="middle" class="dev-t">V1</text>
          </g>
          <path id="pipe-use" class="pipe" d="M290 160 L400 160"/>
          <text x="400" y="152" text-anchor="end" class="lbl">consumo</text>
          <text id="alarm" x="210" y="24" text-anchor="middle" class="alarm"></text>
          <g transform="translate(310,70)"><text class="lbl">LT (IW0)</text><text id="lt" y="22" class="big">0</text></g>
        </svg>`));
      const $ = s => host.querySelector(s);
      const r1 = kit.row(host, 'Operação');
      kit.pushButton(api, r1, { label: 'S1 Auto', addr: 'I0.2', color: 'green' });
      kit.pushButton(api, r1, { label: 'S0 Para', addr: 'I0.3', color: 'red', nc: true });
      const lamps = [
        kit.lamp(api, r1, { label: 'H1 Auto', addr: 'Q0.2', color: 'green' }),
        kit.lamp(api, r1, { label: 'H2 Alarme', addr: 'Q0.3', color: 'red' }),
      ];
      const r2 = kit.row(host, 'Processo (fora do CLP)');
      let use = false, level = 50;
      const useBox = kit.el('input', { type: 'checkbox', onchange: e => { use = e.target.checked; } });
      r2.appendChild(kit.el('label', { class: 'chk' }, [useBox, ` Consumo ligado (−${USE}%/s)`]));
      r2.appendChild(kit.el('button', { class: 'btn', type: 'button', text: 'Esvaziar', onclick: () => { level = 0; } }));
      r2.appendChild(kit.el('button', { class: 'btn', type: 'button', text: 'Nível 50%', onclick: () => { level = 50; } }));

      return {
        step(dt) {
          const s = dt / 1000;
          const pump = !!api.getOutput('Q0.0'), valve = !!api.getOutput('Q0.1');
          if (pump) level += FILL * s;
          if (valve) level -= DRAIN * s;
          if (use) level -= USE * s;
          const overflow = level > 100;
          level = Math.max(0, Math.min(100, level));
          api.setInput('I0.0', level >= LSL ? 1 : 0);
          api.setInput('I0.1', level >= LSH ? 1 : 0);
          api.setInput('IW0', Math.round(level * 10));

          const h = level * 1.58;
          $('#liquid').setAttribute('y', 199 - h);
          $('#liquid').setAttribute('height', h);
          $('#pct').textContent = level.toFixed(0) + '%';
          $('#lt').textContent = Math.round(level * 10);
          $('#pump').classList.toggle('on', pump);
          $('#valve').classList.toggle('on', valve);
          $('#pipe-in').classList.toggle('flow', pump);
          $('#pipe-out').classList.toggle('flow', valve && level > 0);
          $('#pipe-use').classList.toggle('flow', use && level > 0);
          $('#lsh').classList.toggle('on', level >= LSH);
          $('#lsl').classList.toggle('on', level >= LSL);
          $('#alarm').textContent = overflow || (pump && level >= 99.9) ? 'TRANSBORDANDO!' : (level <= 0 && (valve || use) ? 'TANQUE VAZIO' : '');
          lamps.forEach(l => l.update());
        },
        destroy() {},
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
