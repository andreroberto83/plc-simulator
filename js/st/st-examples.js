/* Programas de exemplo em Texto Estruturado (IEC 61131-3) e gerador de declarações de E/S. */
(function (root) {
  'use strict';
  const { Model, Scenes, Addr } = root.PLC;

  /** Bloco VAR com as E/S da cena, já com AT e comentários. */
  function sceneDeclarations(sceneId, indent) {
    const sc = Scenes.get(sceneId);
    const ind = indent == null ? '  ' : indent;
    const rows = sc.io.inputs.concat(sc.io.outputs).map(([addr, name, comment]) => {
      const p = Addr.parse(addr);
      const type = p.kind === 'bit' ? 'BOOL' : 'INT';
      return { decl: `${name} AT ${Addr.iec(addr)} : ${type};`, comment };
    });
    const w = Math.max(...rows.map(r => r.decl.length)) + 2;
    return rows.map(r => `${ind}${r.decl.padEnd(w)}(* ${r.comment} *)`).join('\n');
  }

  function template(sceneId) {
    return `PROGRAM Main
VAR
  (* Entradas e saídas da cena *)
${sceneDeclarations(sceneId)}

  (* Variáveis internas e blocos de função *)

END_VAR

(* Escreva o programa aqui *)

END_PROGRAM
`;
  }

  function project(name, sceneId, src) {
    const p = Model.newProject();
    p.name = name; p.sceneId = sceneId; p.language = 'ST'; p.st = src.replace(/^\n/, '');
    p.rungs = [];
    return p;
  }

  const EXAMPLES = [
    {
      id: 'st-basico', sceneId: 'painel', name: 'Painel — lógica básica',
      build: () => project('Lógica básica (ST)', 'painel', `
PROGRAM LogicaBasica
VAR
  B0    AT %IX0.0 : BOOL;   (* botão NA *)
  B2    AT %IX0.2 : BOOL;
  B3    AT %IX0.3 : BOOL;
  B4_NF AT %IX0.4 : BOOL;   (* botão NF: TRUE em repouso *)
  CH1   AT %IX0.5 : BOOL;
  CH2   AT %IX0.6 : BOOL;
  CH3   AT %IX0.7 : BOOL;
  POT   AT %IW0   : INT;    (* 0..1000 *)
  L0 AT %QX0.0 : BOOL;
  L1 AT %QX0.1 : BOOL;
  L2 AT %QX0.2 : BOOL;
  L4 AT %QX0.4 : BOOL;
  L6 AT %QX0.6 : BOOL;
  L7 AT %QX0.7 : BOOL;
  Memoria : SR;             (* bloco biestável: set dominante *)
END_VAR

L0 := B0;              // contato NA: acende enquanto pressionado
L1 := CH1 AND CH2;     // função E
L2 := CH1 OR CH3;      // função OU
L4 := B4_NF;           // botão NF: lâmpada acesa até apertar
L6 := POT > 500;       // comparação gera um BOOL

(* Set/Reset: B2 liga e mantém, B3 desliga *)
Memoria(S1 := B2, R := B3);
L7 := Memoria.Q1;

END_PROGRAM
`),
    },
    {
      id: 'st-tempo', sceneId: 'painel', name: 'Painel — TON, TOF e TP',
      build: () => project('Temporizadores (ST)', 'painel', `
PROGRAM Temporizadores
VAR
  B2  AT %IX0.2 : BOOL;
  B3  AT %IX0.3 : BOOL;
  CH1 AT %IX0.5 : BOOL;
  L0  AT %QX0.0 : BOOL;
  L2  AT %QX0.2 : BOOL;
  L3  AT %QX0.3 : BOOL;
  Apagado, Aceso : TON;     (* dois TON formam um pisca-pisca *)
  Retardo : TOF;
  Pulso   : TP;
END_VAR

(* Pisca-pisca enquanto CH1 estiver ligada: 500 ms aceso, 500 ms apagado *)
Apagado(IN := CH1 AND NOT Aceso.Q, PT := T#500ms);
Aceso(IN := Apagado.Q, PT := T#500ms);
L0 := Apagado.Q;

(* TOF: L2 apaga 2 s depois de soltar B2 *)
Retardo(IN := B2, PT := T#2s);
L2 := Retardo.Q;

(* TP: um toque em B3 gera um pulso fixo de 1,5 s em L3 *)
Pulso(IN := B3, PT := T#1s500ms, Q => L3);

END_PROGRAM
`),
    },
    {
      id: 'st-contador', sceneId: 'painel', name: 'Painel — contador em binário',
      build: () => project('Contador (ST)', 'painel', `
PROGRAM Contador
VAR
  B0 AT %IX0.0 : BOOL;   (* soma *)
  B1 AT %IX0.1 : BOOL;   (* subtrai *)
  B2 AT %IX0.2 : BOOL;   (* zera *)
  L0 AT %QX0.0 : BOOL;
  L1 AT %QX0.1 : BOOL;
  L2 AT %QX0.2 : BOOL;
  L3 AT %QX0.3 : BOOL;
  L4 AT %QX0.4 : BOOL;
  Cont : CTUD;
  n : INT;
END_VAR

Cont(CU := B0, CD := B1, R := B2, PV := 10);
n := Cont.CV;

(* Mostra o valor em binário nas lâmpadas L0 (bit 0) a L3 (bit 3) *)
L0 := (n MOD 2) = 1;
L1 := ((n / 2) MOD 2) = 1;
L2 := ((n / 4) MOD 2) = 1;
L3 := ((n / 8) MOD 2) = 1;

L4 := Cont.QU;   (* chegou a 10 *)

END_PROGRAM
`),
    },
    {
      id: 'st-media', sceneId: 'painel', name: 'Painel — média móvel com ARRAY e FOR',
      build: () => project('Média móvel (ST)', 'painel', `
PROGRAM MediaMovel
VAR
  POT AT %IW0 : INT;
  L0 AT %QX0.0 : BOOL; L1 AT %QX0.1 : BOOL; L2 AT %QX0.2 : BOOL; L3 AT %QX0.3 : BOOL;
  L4 AT %QX0.4 : BOOL; L5 AT %QX0.5 : BOOL; L6 AT %QX0.6 : BOOL; L7 AT %QX0.7 : BOOL;
  Amostra : ARRAY[0..19] OF INT;   (* últimas 20 leituras *)
  Pos : INT;
  i : INT;
  Soma : DINT;
  Media : INT;
  Barras : INT;
END_VAR

(* Guarda a leitura atual num buffer circular *)
Amostra[Pos] := POT;
Pos := (Pos + 1) MOD 20;

(* Média das 20 amostras: o potenciômetro "demora" a responder *)
Soma := 0;
FOR i := 0 TO 19 DO
  Soma := Soma + Amostra[i];
END_FOR;
Media := DINT_TO_INT(Soma / 20);

(* Barra de 8 lâmpadas: 0..1000 -> 0..8 *)
Barras := Media / 125;
L0 := Barras >= 1; L1 := Barras >= 2; L2 := Barras >= 3; L3 := Barras >= 4;
L4 := Barras >= 5; L5 := Barras >= 6; L6 := Barras >= 7; L7 := Barras >= 8;

END_PROGRAM
`),
    },
    {
      id: 'st-partida', sceneId: 'motor', name: 'Motor — partida direta com selo',
      build: () => project('Partida direta (ST)', 'motor', `
PROGRAM PartidaDireta
VAR
  S1_Liga    AT %IX0.0 : BOOL;   (* botão NA *)
  S0_Desliga AT %IX0.1 : BOOL;   (* botão NF: TRUE em repouso *)
  F1_Termico AT %IX0.2 : BOOL;   (* contato 95-96 NF: FALSE = sobrecarga *)
  K1         AT %QX0.0 : BOOL;   (* contator *)
  H1_Ligado  AT %QX0.1 : BOOL;
  H2_Falha   AT %QX0.2 : BOOL;
END_VAR

(* Selo: K1 se mantém depois de soltar S1.
   S0 e F1 são NF no campo, então aparecem SEM o NOT:
   se um fio romper, a entrada vai a FALSE e o motor para (falha segura). *)
K1 := (S1_Liga OR K1) AND S0_Desliga AND F1_Termico;

H1_Ligado := K1;
H2_Falha  := NOT F1_Termico;

END_PROGRAM
`),
    },
    {
      id: 'st-tanque', sceneId: 'tanque', name: 'Tanque — máquina de estados com CASE',
      build: () => project('Nível por estados (ST)', 'tanque', `
PROGRAM ControleNivel
VAR
  LSL        AT %IX0.0 : BOOL;   (* TRUE = boia coberta *)
  LSH        AT %IX0.1 : BOOL;
  S1_Auto    AT %IX0.2 : BOOL;
  S0_Para    AT %IX0.3 : BOOL;   (* NF *)
  LT_Nivel   AT %IW0   : INT;    (* 0..1000 *)
  P1_Bomba   AT %QX0.0 : BOOL;
  H1_Auto    AT %QX0.2 : BOOL;
  H2_Alarme  AT %QX0.3 : BOOL;
  Auto   : BOOL;
  Estado : INT;                  (* 0 = parado, 1 = enchendo, 2 = aguardando *)
  Pisca, PiscaOff : TON;
END_VAR

Auto := (S1_Auto OR Auto) AND S0_Para;
IF NOT Auto THEN
  Estado := 0;
END_IF;

CASE Estado OF
  0: (* parado *)
     P1_Bomba := FALSE;
     IF Auto THEN Estado := 2; END_IF;
  1: (* enchendo até a boia alta *)
     P1_Bomba := TRUE;
     IF LSH THEN Estado := 2; END_IF;
  2: (* aguardando o nível cair abaixo da boia baixa *)
     P1_Bomba := FALSE;
     IF NOT LSL THEN Estado := 1; END_IF;
END_CASE;

H1_Auto := Auto;

(* Alarme piscante se o transmissor passar de 95% *)
Pisca(IN := NOT PiscaOff.Q, PT := T#300ms);
PiscaOff(IN := Pisca.Q, PT := T#300ms);
H2_Alarme := (LT_Nivel > 950) AND Pisca.Q;

END_PROGRAM
`),
    },
    {
      id: 'st-lote', sceneId: 'esteira', name: 'Esteira — lote de caixas',
      build: () => project('Lote de caixas (ST)', 'esteira', `
PROGRAM Lotes
VAR
  B1_Sensor  AT %IX0.0 : BOOL;
  S1_Liga    AT %IX0.1 : BOOL;
  S0_Desliga AT %IX0.2 : BOOL;   (* NF *)
  S2_Reset   AT %IX0.3 : BOOL;
  M1_Esteira AT %QX0.0 : BOOL;
  H1_Lote    AT %QX0.1 : BOOL;
  H2_Rodando AT %QX0.2 : BOOL;
  Caixas  : CTU;
  FimLote : R_TRIG;
  Lotes   : INT;                 (* lotes completados desde o RUN *)
END_VAR
VAR CONSTANT
  TAMANHO_LOTE : INT := 5;
END_VAR

(* O CTU já conta bordas de subida: basta ligar o sensor em CU *)
Caixas(CU := B1_Sensor, R := S2_Reset, PV := TAMANHO_LOTE);

M1_Esteira := (S1_Liga OR M1_Esteira) AND S0_Desliga AND NOT Caixas.Q;

FimLote(CLK := Caixas.Q);
IF FimLote.Q THEN
  Lotes := Lotes + 1;
END_IF;

H1_Lote    := Caixas.Q;
H2_Rodando := M1_Esteira;

END_PROGRAM
`),
    },
    {
      id: 'st-supervisorio', sceneId: 'tanque', name: 'Tanque — setpoints pelo supervisório (Modbus)',
      build: () => project('Tanque supervisionado (ST)', 'tanque', `
PROGRAM TanqueSupervisionado
VAR
  LSL       AT %IX0.0 : BOOL;
  LT_Nivel  AT %IW0   : INT;     (* 0..1000 *)
  P1_Bomba  AT %QX0.0 : BOOL;
  H1_Auto   AT %QX0.2 : BOOL;
  H2_Alarme AT %QX0.3 : BOOL;

  (* Escritos pelo supervisório (Node-RED) *)
  Auto       AT %MX0.0 : BOOL;   (* coil 1024 *)
  SP_Liga    AT %MD0   : REAL;   (* holding 2048-2049: liga a bomba abaixo deste nível (%) *)
  SP_Desliga AT %MD1   : REAL;   (* holding 2050-2051: desliga acima deste nível (%) *)

  (* Lidos pelo supervisório *)
  Nivel      AT %MD2   : REAL;   (* holding 2052-2053: nível em % *)
  Partidas   AT %MD3   : DINT;   (* holding 2054-2055: quantas vezes a bomba ligou *)
  Ligou : R_TRIG;
END_VAR

Nivel := INT_TO_REAL(LT_Nivel) / 10.0;

(* Valores padrão enquanto o supervisório não escreve *)
IF SP_Liga <= 0.0 THEN SP_Liga := 30.0; END_IF;
IF SP_Desliga <= SP_Liga THEN SP_Desliga := SP_Liga + 40.0; END_IF;

IF NOT Auto THEN
  P1_Bomba := FALSE;
ELSIF Nivel < SP_Liga THEN
  P1_Bomba := TRUE;
ELSIF Nivel > SP_Desliga THEN
  P1_Bomba := FALSE;
END_IF;

Ligou(CLK := P1_Bomba);
IF Ligou.Q THEN
  Partidas := Partidas + 1;
END_IF;

H1_Auto   := Auto;
H2_Alarme := NOT LSL OR (LT_Nivel > 950);

END_PROGRAM
`),
    },
  ];

  /** Trechos prontos para a barra de ST. § = posição do cursor. */
  const SNIPPETS = [
    { label: 'IF', title: 'IF … THEN … END_IF', text: 'IF §condicao THEN\n  \nEND_IF;' },
    { label: 'IF/ELSE', title: 'IF … ELSIF … ELSE … END_IF', text: 'IF §condicao THEN\n  \nELSIF outra THEN\n  \nELSE\n  \nEND_IF;' },
    { label: 'CASE', title: 'Seleção por valor inteiro', text: 'CASE §Estado OF\n  0:\n    \n  1:\n    \nELSE\n  \nEND_CASE;' },
    { label: 'FOR', title: 'Laço com contador', text: 'FOR §i := 0 TO 9 DO\n  \nEND_FOR;' },
    { label: 'WHILE', title: 'Laço com condição no início', text: 'WHILE §condicao DO\n  \nEND_WHILE;' },
    { label: 'REPEAT', title: 'Laço com condição no fim', text: 'REPEAT\n  §\nUNTIL condicao\nEND_REPEAT;' },
    { label: 'TON', fb: 'TON', title: 'Atraso na energização', call: n => `${n}(IN := §entrada, PT := T#1s);` },
    { label: 'TOF', fb: 'TOF', title: 'Atraso na desenergização', call: n => `${n}(IN := §entrada, PT := T#1s);` },
    { label: 'TP', fb: 'TP', title: 'Pulso de duração fixa', call: n => `${n}(IN := §entrada, PT := T#1s);` },
    { label: 'CTU', fb: 'CTU', title: 'Contador crescente', call: n => `${n}(CU := §pulso, R := reset, PV := 10);` },
    { label: 'CTD', fb: 'CTD', title: 'Contador decrescente', call: n => `${n}(CD := §pulso, LD := carrega, PV := 10);` },
    { label: 'R_TRIG', fb: 'R_TRIG', title: 'Detecta borda de subida', call: n => `${n}(CLK := §sinal);\nIF ${n}.Q THEN\n  \nEND_IF;` },
    { label: 'F_TRIG', fb: 'F_TRIG', title: 'Detecta borda de descida', call: n => `${n}(CLK := §sinal);` },
    { label: 'SR', fb: 'SR', title: 'Biestável com set dominante', call: n => `${n}(S1 := §liga, R := desliga);` },
    { label: 'RS', fb: 'RS', title: 'Biestável com reset dominante', call: n => `${n}(S := §liga, R1 := desliga);` },
  ];

  root.PLC = root.PLC || {};
  root.PLC.StExamples = { EXAMPLES, SNIPPETS, template, sceneDeclarations };
})(typeof window !== 'undefined' ? window : globalThis);
