# Simulador de CLP

Simulador de CLP que roda inteiro no navegador, programado em **Texto Estruturado (ST, IEC 61131-3)** ou em **Ladder**, com cenas de entradas e saídas e comunicação **Modbus RTU/TCP** como escravo. Feito para aulas de Automação Industrial.

## Como abrir

Abra `index.html` no **Chrome** ou no **Edge** (dois cliques). Não precisa instalar nada.

- O projeto aberto fica salvo automaticamente no navegador.
- Para guardar uma cópia ou compartilhar, use **Salvar**, que baixa um arquivo `.plc.json`, e **Abrir** para carregá-lo depois.
- O botão no canto direito do topo alterna o tema: **◐ automático** (segue o Windows), **☀ claro** e **☾ escuro**.

### Atalhos

`F5` RUN/STOP · `Ctrl+S` salvar · `Ctrl+Z` / `Ctrl+Y` desfazer/refazer · `Delete` excluir · `↑ ↓` trocar de linha · `Esc` seleciona a linha inteira.

Nas cenas, o **botão direito** num botão pulsador o mantém pressionado, para testar sem segurar o mouse.

## Texto Estruturado (linguagem principal)

Subconjunto da IEC 61131-3 (3ª edição), sem dialeto de fabricante.

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

O compilador verifica tipos como a norma pede e as mensagens de erro indicam a linha e trazem uma dica:

- `BOOL` não aceita número, e `INT` só recebe `REAL` via `REAL_TO_INT`;
- `TIME` só aceita `T#…`;
- entrada `%I` é somente leitura, e `CONSTANT` não pode ser alterada;
- instância de FB não é usada dentro de expressão.

Em RUN:

- cada linha do código mostra à direita o valor das variáveis que usa;
- comandos que não foram executados no último scan ficam esmaecidos (o ramo do IF que não entrou, por exemplo);
- editar o código com o CLP rodando faz troca online: se compilar, o código novo entra mantendo os valores das variáveis; se não compilar, o programa antigo continua rodando;
- laço infinito dispara o watchdog; índice fora do ARRAY ou divisão por zero também levam o CLP a STOP, com a linha indicada.

A barra de ST insere estruturas (IF, CASE, FOR…) e blocos, já com a instância declarada no VAR. O botão **Declarar E/S da cena** gera as linhas `AT` das entradas e saídas da cena.

## Ladder

| Área | Conteúdo |
|---|---|
| Condições | Contato NA, NF, borda de subida (P), borda de descida (N), comparação (`== <> > >= < <=`) |
| Saídas | Bobina, bobina negada, Set, Reset, TON, TOF, TP, CTU, CTD, RES |
| Estrutura | Série e ramos paralelos aninhados, várias saídas em paralelo por linha |
| Endereços | `%IX0.0` ou `I0.0` (idem Q, M), `%IW0`/`IW0`, `T0–T31` (`.EN .TT .DN .ACC .PRE`, em ms), `C0–C31` (`.CU .CD .DN .ACC .PRE`) |
| Símbolos | Tabela de tags; o símbolo pode ser usado no lugar do endereço (`S1_Liga`, `Atraso.DN`) |
| Diagnóstico | Operando inválido, linha sem saída, bobina dupla. Com erro, o CLP não entra em RUN |
| Edição | Desfazer/refazer, mover instruções e linhas, duplicar linha, comentários |

### Como montar uma linha (rung)

1. Selecione a linha (clique no número ou no espaço vazio) e clique em **NA**. O contato vai para o fim da lógica.
2. Com o contato selecionado, troque o modo para **Paralelo** e clique em **NA** de novo. Isso cria um ramo em volta dele (selo).
3. Volte para **Série**, selecione o contato do ramo de cima e adicione mais contatos. Eles entram em série dentro do ramo.
4. Clique numa saída (Bobina, TON…). Ela vai para o fim da linha.
5. Edite o operando no painel **Propriedades**. O Enter confirma.

### Funcionamento

- **Scan:** lê as entradas, executa as linhas de cima para baixo e escreve as saídas. Período padrão de 50 ms, configurável.
- **STOP:** zera as saídas físicas. **RUN:** reinicia toda a memória (não há área retentiva).
- **TON:** `DN` liga quando `ACC ≥ PRE` com a linha energizada e zera quando ela desenergiza.
- **TOF:** `DN` liga junto com a linha e desliga `PRE` ms depois que ela desenergiza.
- **TP:** na borda de subida, `DN` fica ligado por `PRE` ms, independente da entrada.
- **CTU/CTD:** contam bordas de subida da linha; `DN = ACC ≥ PRE`. Um CTU e um CTD podem compartilhar o mesmo `C`.
- **P/N:** a borda é detectada no operando, e a memória é atualizada em todo scan.

## Cenas

Painel de treinamento, Partida direta de motor, Tanque com nível e Esteira com contagem. Cada cena tem exemplos prontos em ST e em Ladder.

## Comunicação Modbus

O CLP simulado é o **escravo** e o Node-RED (ou outro supervisório) é o **mestre**. O mestre lê entradas, saídas e memória, e só escreve na memória `%M`, como um supervisório ligado a um CLP real.

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
- **Valores de 32 bits (`%MD`):** `%MDn` ocupa os holding registers `2048 + 2n` e `2049 + 2n`. Declare no ST como `Temp AT %MD0 : REAL;` ou `Total AT %MD1 : DINT;`. A ordem das palavras (**ABCD** ou **CDAB**) é escolhida na aba **Comunicação**; se aparecer um número absurdo no Node-RED, a ordem está trocada. Leia e escreva sempre os dois registradores juntos (FC 03 e FC 16).
- **Escrita fora de `%M`:** o mestre recebe a exceção 02 (endereço ilegal).
- **Memória em RUN:** `%M` é zerada ao entrar em RUN. Se o mestre escrever um setpoint com o CLP parado, escreva de novo depois do RUN.
- A aba **Variáveis** mostra o endereço Modbus de cada variável declarada com `AT`.
- Funções suportadas: 01, 02, 03, 04, 05, 06, 15 e 16.

O exemplo **Tanque — setpoints pelo supervisório** usa `%MX` e `%MD` para o Node-RED ligar o automático, mudar os setpoints (REAL) e ler o nível e o número de partidas da bomba.

### Modbus RTU (serial)

Funciona só no **Chrome ou Edge**.

1. Crie um par de portas virtuais no **com0com**, por exemplo `COM10 ⇄ COM11`. No Windows 10/11 use a versão com driver assinado.
2. No simulador, abra a aba **Comunicação** e configure a serial (padrão 19200 8N1, ID 1).
3. Clique em **Conectar porta…** e escolha a `COM10`.
4. No Node-RED (`node-red-contrib-modbus`), configure o cliente como Serial RTU na `COM11`, com os mesmos parâmetros e o mesmo Unit ID.

Se a porta do com0com não aparecer na lista, marque a opção **"use Ports class"** no setup do com0com e reinicie o navegador.

### Modbus TCP

O navegador não consegue receber conexões TCP, por isso existe um pequeno gateway que roda no PC com o Node.js (o mesmo usado pelo Node-RED):

```
node tools/modbus-gateway.js                  # mestres em 127.0.0.1:502
node tools/modbus-gateway.js --port 5020      # outra porta
node tools/modbus-gateway.js --host 0.0.0.0   # aceita mestres de outros PCs (o Firewall do Windows vai perguntar)
```

1. Rode o gateway na pasta do projeto.
2. No simulador, clique em **Comunicação → Conectar ao gateway**.
3. No Node-RED, configure o cliente como TCP, host `127.0.0.1`, porta `502`.

Se a página estiver fechada, o mestre recebe a exceção **0x0B** em vez de ficar esperando.

Para testar sem o Node-RED, há um mestre de teste:

```
node tools/modbus-test-master.js                                   # lê todas as tabelas
node tools/modbus-test-master.js --write-coil 1024=1 --write-reg 1025=500
node tools/modbus-test-master.js --poll 500                        # fica lendo
node tools/modbus-test-master.js --write-real 2048=35.5            # 32 bits
```

O CLP continua executando com a aba em segundo plano, então dá para alternar para o Node-RED sem parar o scan.
