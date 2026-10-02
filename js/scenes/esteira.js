(function (root) {
  'use strict';
  const { register, kit } = root.PLC.Scenes;

  const BELT_X0 = 20, BELT_X1 = 380, SENSOR_X = 230, BOX_W = 34, SPEED = 90; // px/s

  register({
    id: 'esteira',
    name: 'Esteira com contagem',
    description: 'Esteira acionada por M1. O sensor fotoelétrico B1 fica em 1 enquanto uma caixa interrompe o feixe. Use um contador (CTU) com borda de subida para contar caixas e parar ao completar o lote. Caixas colocadas com a esteira parada ficam esperando.',
    io: {
      inputs: [
        ['I0.0', 'B1_Sensor', 'Sensor fotoelétrico (1 = caixa no feixe)'],
        ['I0.1', 'S1_Liga', 'Botão liga (NA)'],
        ['I0.2', 'S0_Desliga', 'Botão desliga (NF)'],
        ['I0.3', 'S2_Reset', 'Botão reset do lote (NA)'],
      ],
      outputs: [
        ['Q0.0', 'M1_Esteira', 'Motor da esteira'],
        ['Q0.1', 'H1_Lote', 'Sinaleira lote completo'],
        ['Q0.2', 'H2_Rodando', 'Sinaleira esteira rodando'],
      ],
    },
    create(host, api) {
      host.appendChild(kit.svg(`
        <svg viewBox="0 0 420 170" class="scene-drawing">
          <g id="boxes"></g>
          <rect x="${BELT_X0}" y="100" width="${BELT_X1 - BELT_X0}" height="14" rx="7" class="belt"/>
          <g id="rollers"></g>
          <line id="beam" x1="${SENSOR_X}" y1="40" x2="${SENSOR_X}" y2="98" class="beam"/>
          <rect x="${SENSOR_X - 7}" y="28" width="14" height="12" class="dev"/>
          <text x="${SENSOR_X}" y="22" text-anchor="middle" class="dev-t">B1</text>
          <g transform="translate(40,150)"><text class="lbl">M1</text><circle id="m1" cx="30" cy="-4" r="8" class="dev"/></g>
          <g transform="translate(300,145)"><text class="lbl">Despachadas</text><text id="shipped" x="80" class="big-s">0</text></g>
        </svg>`));
      const $ = s => host.querySelector(s);
      const rollers = $('#rollers');
      const rollerEls = [];
      for (let x = BELT_X0 + 10; x <= BELT_X1 - 10; x += 30) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', `translate(${x},107)`);
        g.innerHTML = '<circle r="5" class="roller"/><line x1="0" y1="-5" x2="0" y2="5" class="roller-l"/>';
        rollers.appendChild(g); rollerEls.push({ g, x });
      }

      const r1 = kit.row(host, 'Operação');
      kit.pushButton(api, r1, { label: 'S1 Liga', addr: 'I0.1', color: 'green' });
      kit.pushButton(api, r1, { label: 'S0 Desliga', addr: 'I0.2', color: 'red', nc: true });
      kit.pushButton(api, r1, { label: 'S2 Reset', addr: 'I0.3', color: 'yellow' });
      const lamps = [
        kit.lamp(api, r1, { label: 'H1 Lote', addr: 'Q0.1', color: 'yellow' }),
        kit.lamp(api, r1, { label: 'H2 Rodando', addr: 'Q0.2', color: 'green' }),
      ];
      const r2 = kit.row(host, 'Processo (fora do CLP)');
      let auto = false, feedTimer = 0, shipped = 0, angle = 0;
      const boxes = [];
      const boxLayer = $('#boxes');
      const addBox = () => {
        if (boxes.some(b => b.x < BELT_X0 + BOX_W + 6)) return; // entrada ocupada
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('width', BOX_W); r.setAttribute('height', 30); r.setAttribute('y', 70); r.setAttribute('rx', 2);
        r.setAttribute('class', 'box-item');
        boxLayer.appendChild(r);
        boxes.push({ x: BELT_X0 + 2, y: 70, vy: 0, el: r });
      };
      r2.appendChild(kit.el('button', { class: 'btn', type: 'button', text: 'Colocar caixa', onclick: addBox }));
      const autoBox = kit.el('input', { type: 'checkbox', onchange: e => { auto = e.target.checked; } });
      r2.appendChild(kit.el('label', { class: 'chk' }, [autoBox, ' Alimentação automática']));
      r2.appendChild(kit.el('button', { class: 'btn', type: 'button', text: 'Limpar esteira', onclick: () => { boxes.splice(0).forEach(b => b.el.remove()); } }));

      return {
        step(dt) {
          const s = dt / 1000;
          const run = !!api.getOutput('Q0.0');
          if (auto) { feedTimer += dt; if (feedTimer > 1800) { feedTimer = 0; addBox(); } }
          for (let i = boxes.length - 1; i >= 0; i--) {
            const b = boxes[i];
            const onBelt = b.x + BOX_W / 2 < BELT_X1;
            if (onBelt) { if (run) b.x += SPEED * s; }
            else { b.x += SPEED * s * 0.6; b.vy += 600 * s; b.y += b.vy * s; }
            if (b.y > 190) { b.el.remove(); boxes.splice(i, 1); shipped++; continue; }
            b.el.setAttribute('x', b.x.toFixed(1));
            b.el.setAttribute('y', b.y.toFixed(1));
            if (!onBelt) b.el.setAttribute('transform', `rotate(${Math.min(60, (b.y - 70) * 0.8)} ${b.x + BOX_W / 2} ${b.y + 15})`);
          }
          const blocked = boxes.some(b => b.y < 100 && b.x <= SENSOR_X && b.x + BOX_W >= SENSOR_X);
          api.setInput('I0.0', blocked ? 1 : 0);
          $('#beam').classList.toggle('blocked', blocked);
          $('#m1').classList.toggle('on', run);
          if (run) angle = (angle + SPEED * s / 5 * 57.3) % 360;
          rollerEls.forEach(r => r.g.setAttribute('transform', `translate(${r.x},107) rotate(${angle.toFixed(0)})`));
          $('#shipped').textContent = shipped;
          lamps.forEach(l => l.update());
        },
        destroy() {},
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
