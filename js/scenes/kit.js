/*
 * Kit de componentes para montar cenas de E/S: botoeiras, chaves,
 * lâmpadas, potenciômetro. Cada componente mostra o endereço ao qual está
 * ligado, como numa etiqueta de borne.
 */
(function (root) {
  'use strict';

  const registry = [];
  const iec = a => (root.PLC.Addr ? root.PLC.Addr.iec(a) : a);

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(c => c && e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  }

  function svg(markup) {
    const wrap = document.createElement('div');
    wrap.className = 'scene-svg';
    wrap.innerHTML = markup;
    return wrap;
  }

  /**
   * Botão pulsador. nc=true: contato NF (entrada = 1 em repouso).
   * Botão direito do mouse trava/destrava o botão pressionado.
   */
  function pushButton(api, parent, o) {
    let pressed = false, latched = false;
    const b = el('button', { class: `pb pb-${o.color || 'gray'}`, type: 'button', title: (o.nc ? 'Contato NF' : 'Contato NA') + ' — clique e segure. Botão direito trava.' });
    const cap = el('span', { class: 'pb-cap' });
    b.appendChild(cap);
    const wrap = el('div', { class: 'widget' }, [b, el('div', { class: 'w-label', text: o.label }), el('div', { class: 'w-addr', text: `${iec(o.addr)} · ${o.nc ? 'NF' : 'NA'}` })]);
    parent.appendChild(wrap);
    const apply = () => {
      const p = pressed || latched;
      b.classList.toggle('down', p);
      b.classList.toggle('latched', latched);
      api.setInput(o.addr, o.nc ? (p ? 0 : 1) : (p ? 1 : 0));
    };
    const down = e => { if (e.button !== 0) return; pressed = true; b.setPointerCapture && b.setPointerCapture(e.pointerId); apply(); };
    const up = () => { if (!pressed) return; pressed = false; apply(); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', e => { e.preventDefault(); latched = !latched; apply(); });
    b.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { pressed = true; apply(); e.preventDefault(); } });
    b.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { pressed = false; apply(); } });
    apply();
    return { get pressed() { return pressed || latched; } };
  }

  /** Chave seletora de 2 posições (mantida). */
  function toggle(api, parent, o) {
    let on = !!o.initial;
    const b = el('button', { class: 'sw', type: 'button', title: 'Chave com retenção — clique para alternar' }, [el('span', { class: 'sw-knob' })]);
    const wrap = el('div', { class: 'widget' }, [b, el('div', { class: 'w-label', text: o.label }), el('div', { class: 'w-addr', text: iec(o.addr) })]);
    parent.appendChild(wrap);
    const apply = () => { b.classList.toggle('on', on); api.setInput(o.addr, on ? 1 : 0); };
    b.addEventListener('click', () => { on = !on; apply(); });
    apply();
    return { get on() { return on; }, set(v) { on = !!v; apply(); } };
  }

  /** Lâmpada sinaleira ligada a uma saída. */
  function lamp(api, parent, o) {
    const l = el('div', { class: `lamp lamp-${o.color || 'green'}` });
    const wrap = el('div', { class: 'widget' }, [l, el('div', { class: 'w-label', text: o.label }), el('div', { class: 'w-addr', text: iec(o.addr) })]);
    parent.appendChild(wrap);
    return { update() { l.classList.toggle('on', !!api.getOutput(o.addr)); } };
  }

  /** Potenciômetro / transmissor analógico -> palavra de entrada. */
  function slider(api, parent, o) {
    const input = el('input', { type: 'range', min: o.min || 0, max: o.max || 1000, step: o.step || 1, value: o.initial || 0 });
    const val = el('span', { class: 'w-val' });
    const wrap = el('div', { class: 'widget widget-wide' }, [el('div', { class: 'w-label', text: o.label }), input, el('div', { class: 'w-addr' }, [iec(o.addr) + ' = ', val])]);
    parent.appendChild(wrap);
    const apply = () => { val.textContent = input.value; api.setInput(o.addr, Number(input.value)); };
    input.addEventListener('input', apply);
    apply();
    return { get value() { return Number(input.value); } };
  }

  function row(parent, title) {
    const r = el('div', { class: 'widget-row' });
    if (title) parent.appendChild(el('div', { class: 'widget-row-title', text: title }));
    parent.appendChild(r);
    return r;
  }

  function register(scene) { registry.push(scene); }
  function list() { return registry.slice(); }
  function get(id) { return registry.find(s => s.id === id) || registry[0]; }

  root.PLC = root.PLC || {};
  root.PLC.Scenes = { register, list, get, kit: { el, svg, pushButton, toggle, lamp, slider, row } };
})(typeof window !== 'undefined' ? window : globalThis);
