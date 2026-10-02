/*
 * Aba "Comunicação": o CLP simulado como escravo Modbus.
 *   - RTU pela serial, usando a Web Serial API (Chrome/Edge) — ex.: par virtual com0com
 *   - TCP pelo gateway local (tools/modbus-gateway.js), ligado à página por WebSocket
 */
(function (root) {
  'use strict';
  const { ModbusSlave, RtuFramer, MAP, EX } = root.PLC.Modbus;
  const SETTINGS_KEY = 'plc-simulator.comm.v1';
  const $ = (h, s) => h.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const EX_TEXT = { 1: 'função ilegal', 2: 'endereço ilegal', 3: 'valor ilegal', 4: 'falha do escravo' };

  const Comm = {
    engine: null, host: null, slave: null,
    settings: { baud: 19200, parity: 'none', stopBits: 1, unitId: 1, wsUrl: 'ws://127.0.0.1:8502', wsAuto: false, wordOrder: 'ABCD' },
    serial: { port: null, reader: null, writer: null, state: 'off', msg: '', framer: null },
    tcp: { ws: null, state: 'off', msg: '', masters: 0, retry: null, wanted: false },
    log: [], dirty: true, lastRender: 0,
    counters: { rtu: 0, tcp: 0, exc: 0 },

    init(engine, host) {
      this.engine = engine;
      this.host = host;
      try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* sem armazenamento */ }
      this.slave = new ModbusSlave(engine.commData(), { unitId: this.settings.unitId, wordOrder: this.settings.wordOrder });
      this.slave.onRequest = info => this.onRequest(info);
      this.build();
      if (this.settings.wsAuto) this.connectTcp();
    },

    save() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignora */ } },

    onRequest(info) {
      info.via = this.currentVia;
      info.t = new Date();
      if (info.exception) this.counters.exc++;
      this.counters[this.currentVia === 'RTU' ? 'rtu' : 'tcp']++;
      this.log.unshift(info);
      if (this.log.length > 14) this.log.length = 14;
      this.dirty = true;
    },

    // ------------------------------------------------------------ interface
    build() {
      const s = this.settings;
      const hasSerial = 'serial' in navigator;
      const opt = (vals, cur) => vals.map(([v, t]) => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${t}</option>`).join('');
      this.host.innerHTML = `
        <section class="comm-box">
          <div class="comm-head"><span class="dot" data-dot="serial"></span><b>Modbus RTU — serial</b></div>
          ${hasSerial ? '' : '<p class="error">Este navegador não tem Web Serial. Use Chrome ou Edge.</p>'}
          <div class="comm-grid">
            <label>Velocidade<select data-set="baud">${opt([[9600, '9600'], [19200, '19200'], [38400, '38400'], [57600, '57600'], [115200, '115200']], s.baud)}</select></label>
            <label>Paridade<select data-set="parity">${opt([['none', 'Nenhuma (N)'], ['even', 'Par (E)'], ['odd', 'Ímpar (O)']], s.parity)}</select></label>
            <label>Stop bits<select data-set="stopBits">${opt([[1, '1'], [2, '2']], s.stopBits)}</select></label>
            <label>ID do escravo<input data-set="unitId" type="number" min="1" max="247" value="${s.unitId}"></label>
          </div>
          <p class="hint">8 bits de dados. O mestre (Node-RED) deve usar os mesmos parâmetros e o mesmo ID.</p>
          <div class="comm-actions">
            <button type="button" class="btn" data-act="serial" ${hasSerial ? '' : 'disabled'}>Conectar porta…</button>
            <span class="comm-status" data-status="serial"></span>
          </div>
        </section>

        <section class="comm-box">
          <div class="comm-head"><span class="dot" data-dot="tcp"></span><b>Modbus TCP — via gateway</b></div>
          <div class="comm-grid one">
            <label>Gateway<input data-set="wsUrl" value="${esc(s.wsUrl)}" spellcheck="false"></label>
          </div>
          <p class="hint">Na pasta do projeto rode <span class="mono">node tools/modbus-gateway.js</span>. O mestre conecta em <span class="mono">127.0.0.1:502</span> (qualquer Unit ID).</p>
          <div class="comm-actions">
            <button type="button" class="btn" data-act="tcp">Conectar ao gateway</button>
            <span class="comm-status" data-status="tcp"></span>
          </div>
        </section>

        <section class="comm-box">
          <div class="comm-head"><b>Tráfego</b><span class="muted" data-counters></span></div>
          <table class="tags comm-log"><thead><tr><th>Hora</th><th>Via</th><th>Função</th><th>Endereço</th><th>Resultado</th></tr></thead><tbody data-log></tbody></table>
        </section>

        <section class="comm-box">
          <div class="comm-head"><b>Mapa de endereços</b> <span class="muted">(base 0, como no Node-RED)</span></div>
          <table class="tags"><thead><tr><th>Tabela Modbus</th><th>Endereços</th><th>CLP</th><th>Mestre</th></tr></thead><tbody>
          ${MAP.map(m => `<tr><td>${{ coil: 'Coils (FC 01/05/15)', discrete: 'Discrete Inputs (FC 02)', input: 'Input Registers (FC 04)', holding: 'Holding Registers (FC 03/06/16)' }[m.table]}</td>
            <td class="mono">${m.start}–${m.start + m.count - 1}</td><td class="mono">${m.label}</td><td>${m.write ? '<b>lê e escreve</b>' : 'lê'}</td></tr>`).join('')}
          </tbody></table>
          <div class="comm-grid one" style="margin-top:8px">
            <label>Ordem das palavras nos valores de 32 bits (%MD)
              <select data-set="wordOrder">${opt([['ABCD', 'ABCD — palavra alta primeiro (padrão Modbus)'], ['CDAB', 'CDAB — palavra baixa primeiro (word swap)']], s.wordOrder)}</select>
            </label>
          </div>
          <p class="hint">Bits: endereço = byte × 8 + bit (ex.: %MX0.1 = coil 1025). Registradores de 16 bits são INT com sinal (complemento de 2).
          <b>%MD</b> ocupa dois registradores: %MD<i>n</i> = holding 2048 + 2<i>n</i> e 2049 + 2<i>n</i>; declare no ST como <span class="mono">AT %MD0 : REAL</span> (IEEE 754) ou <span class="mono">DINT</span>/<span class="mono">UDINT</span>.
          Leia e escreva sempre os dois registradores juntos (FC 03/16). Se aparecer um número absurdo no Node-RED, troque a ordem das palavras aqui ou no conversor do fluxo.
          A memória %M é zerada ao entrar em RUN, como num CLP sem área retentiva.</p>
        </section>`;

      this.host.addEventListener('change', e => {
        const k = e.target.getAttribute('data-set');
        if (!k) return;
        let v = e.target.value;
        if (k === 'baud' || k === 'stopBits' || k === 'unitId') v = Number(v);
        if (k === 'unitId') { v = Math.max(1, Math.min(247, v || 1)); e.target.value = v; this.slave.unitId = v; }
        if (k === 'wordOrder') this.slave.wordOrder = v;
        this.settings[k] = v;
        this.save();
        if ((k === 'baud' || k === 'parity' || k === 'stopBits') && this.serial.port) {
          this.status('serial', 'warn', 'Parâmetros mudaram: desconecte e conecte de novo');
        }
      });
      this.host.addEventListener('click', e => {
        const a = e.target.closest('[data-act]');
        if (!a) return;
        if (a.getAttribute('data-act') === 'serial') this.serial.port ? this.disconnectSerial() : this.connectSerial();
        else this.tcp.wanted ? this.disconnectTcp() : this.connectTcp();
      });
      this.status('serial', 'off', 'desconectado');
      this.status('tcp', 'off', 'desconectado');
    },

    status(ch, state, msg) {
      const o = this[ch];
      o.state = state; o.msg = msg;
      const dot = $(this.host, `[data-dot="${ch}"]`);
      if (dot) dot.className = 'dot ' + state;
      const st = $(this.host, `[data-status="${ch}"]`);
      if (st) st.textContent = msg;
      const btn = $(this.host, `[data-act="${ch}"]`);
      if (btn) btn.textContent = ch === 'serial'
        ? (this.serial.port ? 'Desconectar' : 'Conectar porta…')
        : (this.tcp.wanted ? 'Desconectar' : 'Conectar ao gateway');
      this.updateBadge();
    },

    updateBadge() {
      const b = document.getElementById('comm-badge');
      if (!b) return;
      const on = (this.serial.state === 'on') + (this.tcp.state === 'on');
      b.hidden = !on;
      b.textContent = on;
    },

    /** Chamado pelo laço de desenho da página. */
    render() {
      const now = performance.now();
      if (!this.dirty || now - this.lastRender < 200 || this.host.closest('[hidden]')) return;
      this.dirty = false;
      this.lastRender = now;
      const c = this.counters;
      $(this.host, '[data-counters]').textContent = ` · RTU ${c.rtu} · TCP ${c.tcp} · exceções ${c.exc}` +
        (this.serial.framer && this.serial.framer.crcErrors ? ` · CRC ${this.serial.framer.crcErrors}` : '');
      $(this.host, '[data-log]').innerHTML = this.log.map(i => {
        const t = i.t.toLocaleTimeString('pt-BR');
        const where = i.addr != null ? `${i.addr}${i.qty > 1 ? ` (+${i.qty - 1})` : ''}` : '';
        const res = i.exception ? `<span class="error">exceção ${i.exception}: ${EX_TEXT[i.exception] || ''}</span>` : (i.write ? 'escrito' : 'ok');
        return `<tr><td class="mono">${t}</td><td>${i.via}</td><td class="mono" title="${esc(i.name)}">${String(i.fc).padStart(2, '0')} ${esc(i.name.replace(/^(Read|Write) /, m => m[0] === 'R' ? 'R ' : 'W '))}</td><td class="mono">${where}</td><td>${res}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="muted">Nenhum pedido ainda.</td></tr>';
    },

    // ------------------------------------------------------------ RTU (Web Serial)
    async connectSerial() {
      let port;
      try {
        port = await navigator.serial.requestPort();
      } catch (e) { return; } // usuário cancelou a escolha
      const s = this.settings;
      try {
        await port.open({ baudRate: s.baud, dataBits: 8, stopBits: s.stopBits, parity: s.parity, bufferSize: 4096, flowControl: 'none' });
      } catch (e) {
        this.status('serial', 'err', 'Não abriu: ' + (e.message || e) + ' — a porta está em uso por outro programa?');
        return;
      }
      const info = port.getInfo ? port.getInfo() : {};
      this.serial.port = port;
      this.serial.writer = port.writable.getWriter();
      this.serial.framer = new RtuFramer(frame => {
        this.currentVia = 'RTU';
        const res = this.slave.handleRtuFrame(frame);
        if (res && this.serial.writer) this.serial.writer.write(res).catch(() => {});
      });
      this.status('serial', 'on', `aberta · ${s.baud} ${s.parity === 'none' ? 'N' : s.parity === 'even' ? 'E' : 'O'} 8 ${s.stopBits} · ID ${s.unitId}${info.usbVendorId ? '' : ''}`);
      this.readLoop(port);
    },

    async readLoop(port) {
      while (this.serial.port === port && port.readable) {
        const reader = port.readable.getReader();
        this.serial.reader = reader;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) this.serial.framer.push(value);
          }
        } catch (e) {
          // erro de quadro/paridade: continua lendo; porta removida: sai
          if (this.serial.port === port) this.status('serial', 'warn', 'Erro na serial: ' + (e.message || e));
        } finally {
          try { reader.releaseLock(); } catch (e) { /* ignora */ }
        }
        if (this.serial.port !== port) break;
      }
      if (this.serial.port === port) this.disconnectSerial('porta fechada ou removida');
    },

    async disconnectSerial(reason) {
      const { port, reader, writer } = this.serial;
      this.serial.port = null;
      try { if (reader) await reader.cancel(); } catch (e) { /* ignora */ }
      try { if (writer) writer.releaseLock(); } catch (e) { /* ignora */ }
      try { if (port) await port.close(); } catch (e) { /* ignora */ }
      this.serial.reader = this.serial.writer = null;
      this.status('serial', 'off', reason || 'desconectado');
    },

    // ------------------------------------------------------------ TCP (gateway por WebSocket)
    connectTcp() {
      this.tcp.wanted = true;
      this.settings.wsAuto = true;
      this.save();
      this.openWs();
    },

    openWs() {
      clearTimeout(this.tcp.retry);
      if (!this.tcp.wanted) return;
      let ws;
      try { ws = new WebSocket(this.settings.wsUrl); }
      catch (e) { this.status('tcp', 'err', 'URL inválida'); return; }
      ws.binaryType = 'arraybuffer';
      this.tcp.ws = ws;
      this.status('tcp', 'warn', 'procurando o gateway…');
      ws.onopen = () => this.status('tcp', 'on', 'conectado ao gateway');
      ws.onmessage = ev => {
        if (typeof ev.data === 'string') {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === 'status') {
              this.tcp.masters = m.masters;
              this.status('tcp', 'on', `gateway na porta ${m.tcpPort} · ${m.masters} mestre(s) conectado(s)`);
            }
          } catch (e) { /* ignora */ }
          return;
        }
        const buf = new Uint8Array(ev.data);
        if (buf.length < 3) return;
        this.currentVia = 'TCP';
        const res = this.slave.handleTcpAdu(buf.subarray(2));
        if (!res) return;
        const out = new Uint8Array(2 + res.length);
        out.set(buf.subarray(0, 2)); out.set(res, 2);
        if (ws.readyState === 1) ws.send(out);
      };
      ws.onclose = () => {
        if (this.tcp.ws !== ws) return;
        this.tcp.ws = null;
        if (this.tcp.wanted) {
          this.status('tcp', 'warn', 'gateway não encontrado — tentando de novo a cada 2 s');
          this.tcp.retry = setTimeout(() => this.openWs(), 2000);
        } else this.status('tcp', 'off', 'desconectado');
      };
      ws.onerror = () => { /* o onclose trata */ };
    },

    disconnectTcp() {
      this.tcp.wanted = false;
      this.settings.wsAuto = false;
      this.save();
      clearTimeout(this.tcp.retry);
      const ws = this.tcp.ws;
      this.tcp.ws = null;
      if (ws) ws.close();
      this.status('tcp', 'off', 'desconectado');
    },
  };

  void EX;
  root.PLC = root.PLC || {};
  root.PLC.Comm = Comm;
})(typeof window !== 'undefined' ? window : globalThis);
