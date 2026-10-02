(function (root) {
  'use strict';
  const { register, kit } = root.PLC.Scenes;

  register({
    id: 'motor',
    name: 'Partida direta de motor',
    description: 'Motor trifásico com contator K1 e relé térmico F1. <b>Atenção:</b> S0 (desliga) e o contato 95-96 do F1 são <b>NF</b>, como em campo — em repouso a entrada está em 1, então no programa eles entram como contato <b>NA</b>. Se o fio romper, a entrada vai a 0 e o motor para (falha segura).',
    io: {
      inputs: [
        ['I0.0', 'S1_Liga', 'Botão liga (NA)'],
        ['I0.1', 'S0_Desliga', 'Botão desliga (NF)'],
        ['I0.2', 'F1_Termico', 'Relé térmico 95-96 (NF, abre na sobrecarga)'],
      ],
      outputs: [
        ['Q0.0', 'K1', 'Contator do motor'],
        ['Q0.1', 'H1_Ligado', 'Sinaleira verde — motor ligado'],
        ['Q0.2', 'H2_Falha', 'Sinaleira vermelha — falha'],
      ],
    },
    create(host, api) {
      host.appendChild(kit.svg(`
        <svg viewBox="0 0 420 190" class="scene-drawing">
          <g class="lbl"><text x="20" y="22">L1 L2 L3</text></g>
          <g class="pwr">
            <line x1="30" y1="30" x2="30" y2="60"/><line x1="45" y1="30" x2="45" y2="60"/><line x1="60" y1="30" x2="60" y2="60"/>
          </g>
          <g id="k1">
            <rect x="15" y="60" width="60" height="40" rx="4" class="dev"/>
            <text x="45" y="84" text-anchor="middle" class="dev-t">K1</text>
          </g>
          <g class="pwr"><line x1="30" y1="100" x2="30" y2="115"/><line x1="45" y1="100" x2="45" y2="115"/><line x1="60" y1="100" x2="60" y2="115"/></g>
          <g id="f1">
            <rect x="15" y="115" width="60" height="30" rx="4" class="dev"/>
            <text x="45" y="135" text-anchor="middle" class="dev-t">F1</text>
          </g>
          <path class="pwr" d="M45 145 L45 165 L150 165"/>
          <g transform="translate(210,110)">
            <circle r="52" class="motor-body"/>
            <g id="rotor">
              <path class="blade" d="M0 -40 L8 -6 L-8 -6 Z"/><path class="blade" d="M0 -40 L8 -6 L-8 -6 Z" transform="rotate(120)"/><path class="blade" d="M0 -40 L8 -6 L-8 -6 Z" transform="rotate(240)"/>
              <circle r="7" class="hub"/>
            </g>
            <text y="72" text-anchor="middle" class="dev-t">M 3~</text>
          </g>
          <g transform="translate(320,40)">
            <text x="0" y="0" class="lbl">Rotação</text>
            <text id="rpm" x="0" y="24" class="big">0 rpm</text>
            <text x="0" y="60" class="lbl">Corrente</text>
            <text id="amp" x="0" y="84" class="big">0,0 A</text>
            <text id="trip" x="0" y="118" class="alarm"></text>
          </g>
        </svg>`));
      const $ = sel => host.querySelector(sel);
      const r1 = kit.row(host, 'Botoeira');
      kit.pushButton(api, r1, { label: 'S1 Liga', addr: 'I0.0', color: 'green' });
      kit.pushButton(api, r1, { label: 'S0 Desliga', addr: 'I0.1', color: 'red', nc: true });
      const lamps = [
        kit.lamp(api, r1, { label: 'H1 Ligado', addr: 'Q0.1', color: 'green' }),
        kit.lamp(api, r1, { label: 'H2 Falha', addr: 'Q0.2', color: 'red' }),
      ];
      const r2 = kit.row(host, 'Processo (fora do CLP)');
      let tripped = false, overloadTime = 0, heavy = false;
      const bTrip = kit.el('button', { class: 'btn', type: 'button', text: 'Provocar sobrecarga', onclick: () => { tripped = true; } });
      const bReset = kit.el('button', { class: 'btn', type: 'button', text: 'Rearmar F1', onclick: () => { tripped = false; overloadTime = 0; } });
      const heavyBox = kit.el('input', { type: 'checkbox', onchange: e => { heavy = e.target.checked; } });
      r2.appendChild(bTrip); r2.appendChild(bReset);
      r2.appendChild(kit.el('label', { class: 'chk' }, [heavyBox, ' Carga excessiva (desarma F1 após 3 s)']));

      let speed = 0, angle = 0;
      return {
        step(dt) {
          const k1 = !!api.getOutput('Q0.0');
          const energized = k1 && !tripped;
          if (energized && heavy) { overloadTime += dt; if (overloadTime > 3000) tripped = true; }
          else overloadTime = Math.max(0, overloadTime - dt);
          api.setInput('I0.2', tripped ? 0 : 1);
          const target = energized ? (heavy ? 0.8 : 1) : 0;
          speed += (target - speed) * Math.min(1, dt / (energized ? 700 : 1200));
          if (speed < 0.002 && !energized) speed = 0;
          angle = (angle + speed * dt * 0.9) % 360;
          $('#rotor').setAttribute('transform', `rotate(${angle.toFixed(1)})`);
          $('#k1').classList.toggle('on', k1);
          $('#f1').classList.toggle('alarm-dev', tripped);
          $('#rpm').textContent = Math.round(speed * 1750) + ' rpm';
          const amps = energized ? (speed < 0.9 && !heavy ? 6 * (1 - speed) + 1.2 : heavy ? 2.9 : 1.2) : 0;
          $('#amp').textContent = amps.toFixed(1).replace('.', ',') + ' A';
          $('#trip').textContent = tripped ? 'F1 DESARMADO' : '';
          lamps.forEach(l => l.update());
        },
        destroy() {},
      };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
