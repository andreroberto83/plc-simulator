# Simulador de CLP

Simulador de CLP que roda inteiro no navegador, programado em **Texto Estruturado (ST, IEC 61131-3)** ou em **Ladder**. Foi inspirado no plcIOsim e pensado para aulas de Automação Industrial.

## Texto Estruturado (linguagem principal)

É um subconjunto da IEC 61131-3 (3ª edição), sem dialeto de fabricante.

| Área | Suportado |
|---|---|
| Estrutura | `PROGRAM … END_PROGRAM` (opcional), `VAR`, `VAR CONSTANT`, vários blocos VAR |
| Tipos | `BOOL SINT INT DINT UINT UDINT REAL LREAL TIME`, `ARRAY[a..b] OF <tipo>` com valores iniciais |
| E/S | `Liga AT %IX0.0 : BOOL;`, `%QX`, `%MX`, `%IW`, `%QW`, `%MW` (16 bits), `%MD0…%MD15` (32 bits: `DINT`, `UDINT` ou `REAL`) |
| Comandos | `:=`, `IF/ELSIF/ELSE`, `CASE` (com faixas `2..5`), `FOR … BY`, `WHILE`, `REPEAT/UNTIL`, `EXIT`, `RETURN` |
| Operadores | `** - NOT * / MOD + - < > <= >= = <> AND & XOR OR`, com a precedência da norma |
| Blocos de função | `TON TOF TP CTU CTD CTUD R_TRIG F_TRIG SR RS`, chamada formal: `T1(IN := x, PT := T#2s, Q => y);` |
| Funções | `ABS SQRT MIN MAX LIMIT SEL MOVE TRUNC` e conversões `X_TO_Y` (`REAL_TO_INT` arredonda) |
| Literais | `T#1m30s`, `T#500ms`, `16#FF`, `2#1010`, `1_000`, `2.5E3`; comentários `(* *)` e `//` |

O compilador verifica tipos como a norma pede:

- `BOOL` não aceita número, e `INT` só recebe `REAL` via `REAL_TO_INT`;
- `TIME` só aceita `T#…`;
- entrada `%I` é somente leitura, e `CONSTANT` não pode ser alterada;
- instância de FB não é usada dentro de expressão.

As mensagens de erro dão a linha e uma dica.

Em RUN:

- cada linha mostra à direita o valor das variáveis que usa;
- comandos que não foram executados no último scan ficam esmaecidos (o ramo do IF que não entrou, por exemplo);
- editar o código com o CLP rodando faz troca online: se compilar, o código novo entra no lugar mantendo os valores das variáveis; se não compilar, o programa antigo continua rodando;
- laço infinito dispara o watchdog, e índice fora do ARRAY ou divisão por zero também levam o CLP a STOP, com a linha indicada.

A barra de ST insere estruturas (IF, CASE, FOR…) e blocos. Um bloco já vem com a instância declarada no VAR. O botão **Declarar E/S da cena** gera as linhas `AT` das entradas e saídas da cena.

## Comunicação Modbus (o simulador é o escravo)

O CLP simulado responde como **escravo Modbus**, e o Node-RED (ou outro supervisório) é o **mestre**. O mestre lê entradas, saídas e memória; só escreve na memória `%M`, igual a um supervisório ligado a um CLP real.

### Mapa de endereços (base 0, como no Node-RED)

| Tabela Modbus | Endereços | CLP | Mestre |
|---|---|---|---|
| Discrete Inputs (FC 02) | 0–63 | `%IX0.0 … %IX7.7` | lê |
| Coils (FC 01) | 0–63 | `%QX0.0 … %QX7.7` | lê |
| Coils (FC 01/05/15) | 1024–1279 | `%MX0.0 … %MX31.7` | lê e escreve |
| Input Registers (FC 04) | 0–7 | `%IW0 … %IW7` | lê |
| Holding Registers (FC 03) | 0–7 | `%QW0 … %QW7` | lê |
| Holding Registers (FC 03/06/16) | 1024–1055 | `%MW0 … %MW31` | lê e escreve |
| Holding Registers (FC 03/06/16) | 2048–2079 | `%MD0 … %MD15` (2 registradores cada) | lê e escreve |

- **Bits:** endereço = byte × 8 + bit. Exemplo: `%MX0.1` é o coil 1025, e `%IX1.2` é o discrete input 10.
- **Registradores de 16 bits:** INT com sinal, em complemento de 2 (−1 chega como 65535 se o mestre ler "sem sinal").
- **Valores de 32 bits (`%MD`):**
  - `%MDn` ocupa os holding registers `2048 + 2n` e `2049 + 2n`. Declare no ST como `Temp AT %MD0 : REAL;` (IEEE 754) ou `Total AT %MD1 : DINT;`.
  - A ordem das palavras é configurável na aba **Comunicação**: **ABCD** (palavra alta primeiro, o padrão) ou **CDAB** (word swap). Se aparecer um número absurdo no Node-RED, a ordem está trocada.
  - Leia e escreva sempre os dois registradores juntos (FC 03 e FC 16). Se o mestre escrever as metades com FC 06, o programa pode ver, por um scan, um valor com meia palavra nova e meia antiga, como num CLP real.
  - O exemplo **Tanque — setpoints pelo supervisório** usa `%MX` e `%MD` para o Node-RED ligar o automático, mudar os setpoints em % (REAL) e ler o nível e o número de partidas da bomba.
- **Escrita fora de `%M`:** o mestre recebe a exceção 02 (endereço ilegal).
- **Memória em RUN:** `%M` é zerada ao entrar em RUN. Se o mestre escrever um setpoint com o CLP parado, escreva de novo depois do RUN.
- **Programa em ST:** declare `Setpoint AT %MW0 : INT;` e use normalmente. A aba **Variáveis** mostra o endereço Modbus de cada variável com `AT`.

### Modbus RTU pela serial (sem instalar nada no simulador)

A página usa a **Web Serial API**, que só existe no **Chrome ou Edge**.

1. Crie um par de portas virtuais no **com0com**, por exemplo `COM10 ⇄ COM11`. No Windows 10/11 use a versão com driver assinado.
2. No simulador, abra a aba **Comunicação** e configure a serial: velocidade, paridade, stop bits e ID do escravo (padrão 19200 8N1, ID 1).
3. Clique em **Conectar porta…** e escolha a `COM10`. O navegador sempre pede essa escolha por clique.
4. No Node-RED (`node-red-contrib-modbus`), configure o cliente como Serial RTU na `COM11`, com os mesmos parâmetros e o mesmo Unit ID.

Se a porta do com0com não aparecer na lista do Chrome, marque a opção **"use Ports class"** no setup do com0com e reinicie o navegador.

### Modbus TCP pelo gateway

O navegador não consegue abrir uma porta TCP para escutar conexões, por isso existe um gateway de um arquivo só, sem dependências (precisa apenas do Node.js, que você já tem por causa do Node-RED).

```
node tools/modbus-gateway.js                  # mestres em 127.0.0.1:502
node tools/modbus-gateway.js --port 5020      # outra porta
node tools/modbus-gateway.js --host 0.0.0.0   # aceita mestres de outros PCs (o Firewall do Windows vai perguntar)
```

1. Rode o gateway na pasta do projeto.
2. No simulador, clique em **Comunicação → Conectar ao gateway**. A conexão é refeita sozinha se o gateway reiniciar.
3. No Node-RED, configure o cliente como TCP, host `127.0.0.1`, porta `502`. O Unit ID pode ser qualquer um.

Se a página estiver fechada ou desconectada, o mestre recebe a exceção **0x0B** (o gateway não obteve resposta), em vez de ficar esperando.

Para conferir sem o Node-RED, use o mestre de teste:

```
node tools/modbus-test-master.js                                   # lê todas as tabelas
node tools/modbus-test-master.js --write-coil 1024=1 --write-reg 1025=500
node tools/modbus-test-master.js --poll 500                        # fica lendo
node tools/modbus-test-master.js --write-real 2048=35.5 --write-dint 2050=1000   # 32 bits (ABCD)
node tools/modbus-test-master.js --swap                             # lê/escreve 32 bits como CDAB
```

### Detalhes

- **Scan com a janela em segundo plano:** o scan roda num relógio de Web Worker, então o CLP continua executando quando você troca de janela para o Node-RED. A animação da cena também continua.
- **Montagem dos quadros RTU:** os quadros são montados pelo tamanho de cada função e pela verificação do CRC, sem depender do silêncio de 3,5 caracteres. Um quadro com erro de CRC é descartado e contado na aba **Comunicação**.
- **Funções suportadas:** 01, 02, 03, 04, 05, 06, 15, 16. Qualquer outra recebe a exceção 01.

## Como abrir

Dê dois cliques em `index.html` (Chrome ou Edge). Não precisa de servidor, `npm install` nem build.

Todos os scripts são clássicos (sem `import`/ES modules), porque o navegador bloqueia módulos abertos via `file://`. Com isso, a pasta pode ficar no Google Drive sem criar `node_modules`.

O projeto aberto é salvo automaticamente no navegador (localStorage). Para guardar ou compartilhar, use **Salvar**, que baixa um `.plc.json`, e **Abrir**.

## Ladder

| Área | Conteúdo |
|---|---|
| Condições | Contato NA, NF, borda de subida (P), borda de descida (N), comparação (`== <> > >= < <=`) |
| Saídas | Bobina, bobina negada, Set, Reset, TON, TOF, TP, CTU, CTD, RES |
| Estrutura | Série e ramos paralelos aninhados, várias saídas em paralelo por degrau |
| Endereços | `%IX0.0` ou `I0.0` (idem Q, M), `%IW0`/`IW0`, `T0–T31` (`.EN .TT .DN .ACC .PRE`, em ms), `C0–C31` (`.CU .CD .DN .ACC .PRE`) |
| Símbolos | Tabela de tags; o símbolo pode ser usado no lugar do endereço (`S1_Liga`, `Atraso.DN`) |
| Cenas | Painel de treinamento, Partida direta de motor, Tanque com nível, Esteira com contagem |
| Diagnóstico | Operando inválido, degrau sem saída, bobina dupla. Com erro o CLP não entra em RUN |
| Edição | Desfazer/refazer, mover instruções e degraus, duplicar degrau, comentários |

### Atalhos

`F5` RUN/STOP · `Ctrl+S` salvar · `Ctrl+Z` / `Ctrl+Y` desfazer/refazer · `Delete` excluir · `↑ ↓` trocar de degrau · `Esc` seleciona o degrau inteiro.

Nas cenas, o **botão direito** num botão pulsador trava o botão apertado, para testar sem segurar o mouse.

## Como montar um degrau

1. Selecione o degrau (clique no número ou no espaço vazio) e clique em **NA**. O contato vai para o fim da lógica.
2. Com o contato selecionado, troque o modo para **Paralelo** e clique em **NA** de novo. Isso cria um ramo em volta dele (selo).
3. Volte para **Série**, selecione o contato do ramo de cima e adicione mais contatos. Eles entram em série dentro do ramo.
4. Clique numa saída (Bobina, TON…). Ela vai para o fim do degrau.
5. Edite o operando no painel **Propriedades**. O Enter confirma.

## Semântica (resumo)

- **Scan:** lê as entradas, executa os degraus de cima para baixo e escreve as saídas. O período padrão é 50 ms, configurável.
- **STOP:** zera as saídas físicas. **RUN:** reinicia toda a memória, sem área retentiva.
- **TON:** `DN` liga quando `ACC ≥ PRE` com o degrau energizado, e zera quando o degrau desenergiza.
- **TOF:** `DN` liga junto com o degrau e desliga `PRE` ms depois que o degrau desenergiza.
- **TP:** na borda de subida, `DN` fica ligado por `PRE` ms, independente da entrada.
- **CTU/CTD:** contam bordas de subida do degrau; `DN = ACC ≥ PRE`. Um CTU e um CTD podem compartilhar o mesmo `C`.
- **P/N:** a borda é detectada no operando, e a memória é atualizada em todo scan.

## Estrutura

```
index.html                   página (fica na raiz: é o que a hospedagem serve)
assets/css/style.css         estilos
js/core/addresses.js         endereçamento e símbolos
js/core/model.js             modelo do programa (árvore série/paralelo) e operações de edição
js/core/engine.js            runtime do CLP (compilação, scan, temporizadores, contadores)
js/st/st.js                  Texto Estruturado: léxico, sintaxe, tipos, execução, FBs IEC
js/st/st-editor.js           editor de ST com realce e monitoração
js/st/st-examples.js         exemplos em ST, trechos prontos e gerador de declarações
js/ladder/ladder-view.js     desenho do ladder em SVG
js/ladder/ladder-examples.js programas de exemplo em Ladder
js/scenes/*.js               cenas de E/S (kit.js = botoeiras, chaves, lâmpadas, potenciômetro)
js/comm/modbus-core.js       Modbus escravo: funções, exceções, CRC, quadros RTU e TCP (usado também no Node)
js/comm/comm-ui.js           aba Comunicação: Web Serial (RTU) e cliente do gateway (TCP)
js/app.js                    interface
tools/modbus-gateway.js      gateway Modbus TCP ⇄ página (Node, sem dependências; roda no PC, não no site)
tools/modbus-test-master.js  mestre Modbus TCP de teste
tests/*.test.js              testes (Node)
```

`js/core/` é o CLP em si, sem interface: é o que os testes carregam e o que um backend futuro reaproveitaria.

Testes (precisa de Node): `node tests/st.test.js`, `node tests/modbus.test.js` e `node tests/engine.test.js`

### Criar uma cena nova

Copie `js/scenes/painel.js`, mude `id`, `name`, `io` e `create()`, e inclua o `<script>` no `index.html` antes de `ladder-examples.js`. `create(host, api)` recebe:

- `api.setInput(endereço, valor)`: a cena escreve as entradas.
- `api.getOutput(endereço)`: a cena lê as saídas.

`step(dt)` é chamado a cada quadro de animação.

## Próximos passos

1. **Exercícios com verificação:** enunciado mais casos de teste (sequência de entradas → saídas esperadas).

### Backend Spring

A simulação não precisa de servidor. Um backend Spring Boot só passa a fazer sentido para:

- salvar projetos por aluno/turma (REST + PostgreSQL), substituindo o localStorage;
- enviar exercícios com verificação automática (o servidor roda o mesmo `engine.js` via GraalJS, ou uma reimplementação em Java, contra casos de teste);
- servir esta pasta como conteúdo estático (`src/main/resources/static`).
