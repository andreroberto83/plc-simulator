# Simulador de CLP

Simulador de CLP para aulas de Automação Industrial. Você programa em **Texto Estruturado (ST, IEC 61131-3)** ou em **Ladder**, testa o programa numa cena com botões, lâmpadas e processos, e pode ligar o CLP simulado a um supervisório como o **Node-RED** via **Modbus**.

### ▶ [Acessar o simulador](https://andreroberto83.github.io/plc-simulator/)

Use o **Chrome** ou o **Edge**, no computador. Não precisa instalar nada.

## Primeiros passos

1. Abra o link acima.
2. Em **Exemplos…**, escolha um programa pronto, por exemplo “Motor — partida direta com selo”. A cena muda junto.
3. Clique em **▶ RUN** (ou aperte `F5`).
4. Use os botões da cena e observe as lâmpadas e o programa.
5. Clique em **STOP** para parar.

## A tela

| Área | Para que serve |
|---|---|
| Topo | Escolha da linguagem (**ST** ou **Ladder**), Novo, Abrir, Salvar, Exemplos, RUN/STOP, tempo de scan e tema |
| Barra abaixo do topo | Insere estruturas e blocos (ST) ou contatos e saídas (Ladder) |
| Centro | O programa |
| Direita, em cima | A cena: entradas (botões, chaves, sensores) e saídas (lâmpadas, motor, bomba) |
| Direita, embaixo | Abas de referência, variáveis ou tags, diagnóstico (erros e avisos) e comunicação |

As divisórias podem ser arrastadas. Um duplo clique numa divisória volta ao tamanho padrão; na divisória do painel lateral, o duplo clique esconde ou mostra o painel. A caixa **Tema** escolhe entre Sistema (segue o Windows), Claro e Escuro.

## Salvar seu trabalho

- O projeto aberto fica guardado **neste navegador, neste computador**. Ao voltar ao link, ele estará lá.
- Para levar para outro computador, entregar ou compartilhar, use **Salvar**: o navegador baixa um arquivo `.plc.json`. Depois, **Abrir** carrega esse arquivo.
- **Novo** e **Exemplos…** substituem o programa atual. O simulador pergunta antes; salve se quiser manter.

## Atalhos

| Tecla | Ação |
|---|---|
| `F5` | RUN / STOP |
| `Ctrl+S` | Salvar arquivo |
| `Ctrl+Z` / `Ctrl+Y` | Desfazer / refazer |
| `Delete` | Excluir a instrução selecionada (Ladder) |
| `↑` `↓` | Trocar de linha (Ladder) |
| `Esc` | Selecionar a linha inteira (Ladder) |

Nas cenas, o **botão direito** num botão pulsador o mantém apertado até um novo clique direito, para testar sem segurar o mouse.

## Como o CLP executa

- **Scan:** a cada ciclo o CLP lê as entradas, executa o programa e escreve as saídas. O tempo de ciclo padrão é 50 ms e pode ser mudado no topo.
- **STOP:** todas as saídas desligam.
- **RUN:** a memória começa zerada (não há área retentiva). Variáveis voltam aos valores iniciais declarados.
- **Erros:** com erro no programa, o CLP não entra em RUN. A aba **Diagnóstico** mostra a linha e uma dica de correção.

## Texto Estruturado (ST)

### Exemplo

```
VAR
  S1_Liga    AT %IX0.0 : BOOL;   (* botão NA *)
  S0_Desliga AT %IX0.1 : BOOL;   (* botão NF *)
  K1         AT %QX0.0 : BOOL;   (* contator *)
  Atraso     : TON;
END_VAR

K1 := (S1_Liga OR K1) AND S0_Desliga;
Atraso(IN := K1, PT := T#5s);
%QX0.1 := Atraso.Q;
```

O botão **Declarar E/S da cena** escreve as linhas `AT` das entradas e saídas da cena que ainda não foram declaradas. A barra de ST insere estruturas (IF, CASE, FOR…) e blocos (TON, CTU…), já com a instância declarada.

### O que a linguagem aceita

| Área | Suportado |
|---|---|
| Estrutura | `PROGRAM … END_PROGRAM` (opcional), `VAR`, `VAR CONSTANT` |
| Tipos | `BOOL SINT INT DINT UINT UDINT REAL LREAL TIME`, `ARRAY[a..b] OF <tipo>` |
| Entradas e saídas | `%IX` `%QX` `%MX` (bits), `%IW` `%QW` `%MW` (16 bits: `INT` ou `UINT`), `%MD0…%MD15` (32 bits: `DINT`, `UDINT` ou `REAL`) |
| Comandos | `:=`, `IF/ELSIF/ELSE`, `CASE` (com faixas `2..5`), `FOR … BY`, `WHILE`, `REPEAT/UNTIL`, `EXIT`, `RETURN` |
| Operadores | `** - NOT * / MOD + - < > <= >= = <> AND & XOR OR` |
| Blocos de função | `TON TOF TP CTU CTD CTUD R_TRIG F_TRIG SR RS`, chamados como `T1(IN := x, PT := T#2s);` |
| Funções | `ABS SQRT MIN MAX LIMIT SEL MOVE TRUNC` e conversões `X_TO_Y` (`REAL_TO_INT` arredonda) |
| Valores | `T#1m30s`, `T#500ms`, `16#FF`, `2#1010`, `1_000`, `2.5E3`; comentários `(* *)` e `//` |

A aba **Referência** traz o resumo dos blocos e funções enquanto você programa.

### Regras que o simulador confere

- `BOOL` não recebe número; para usar um número como condição, compare: `x > 0`.
- `INT` só recebe `REAL` por conversão: `REAL_TO_INT(...)`.
- `TIME` só aceita valores `T#…`.
- Entradas `%I` são somente leitura, e `CONSTANT` não pode ser alterada.
- Bloco de função não é usado dentro de expressão: chame-o numa linha própria e use a saída, como `T1.Q`.

### Em RUN

- Cada linha mostra à direita os valores das variáveis que usa.
- Linhas que não executaram no último ciclo ficam esmaecidas (por exemplo, o ramo do IF que não entrou).
- Dá para **editar com o CLP rodando**: se o código novo estiver certo, ele entra na hora e as variáveis mantêm os valores; se tiver erro, o programa anterior continua rodando.
- Laço infinito, índice fora do ARRAY e divisão por zero param o CLP (STOP) e indicam a linha.

## Ladder

### Montar uma linha (rung)

1. Selecione a linha clicando no número dela (ou use **+ Degrau** para criar uma) e clique em **NA**. O contato entra no fim da lógica.
2. Com o contato selecionado, troque o modo para **Paralelo** e clique em **NA** de novo. Isso cria um ramo em volta dele (selo).
3. Volte para **Série**. Selecionando um contato do ramo, os novos contatos entram dentro do ramo; selecionando a linha pelo número, entram depois dele.
4. Clique numa saída (Bobina, TON…). Ela vai para o fim da linha.
5. Digite o endereço no painel **Propriedades** e confirme com Enter.

### Instruções e endereços

| Área | Conteúdo |
|---|---|
| Condições | Contato NA, NF, borda de subida (P), borda de descida (N), comparação (`== <> > >= < <=`) |
| Saídas | Bobina, bobina negada, Set, Reset, TON, TOF, TP, CTU, CTD, RES |
| Endereços | `I0.0` ou `%IX0.0` (idem Q e M), `IW0`, temporizadores `T0–T31` (`.EN .TT .DN .ACC .PRE`, em ms), contadores `C0–C31` (`.CU .CD .DN .ACC .PRE`) |
| Símbolos | Na aba **Tags**, dê nomes aos endereços e use o nome no lugar do endereço (`S1_Liga`, `Atraso.DN`) |
| Avisos | Endereço inválido, linha sem saída e bobina dupla aparecem no Diagnóstico |

### Temporizadores e contadores

- **TON:** `DN` liga quando o tempo acumulado chega ao preset com a linha energizada, e desliga quando a linha desenergiza.
- **TOF:** `DN` liga junto com a linha e desliga o tempo do preset depois que ela desenergiza.
- **TP:** na borda de subida, `DN` fica ligado pelo tempo do preset, mesmo que a entrada desligue antes.
- **CTU / CTD:** contam bordas de subida da linha; `DN` liga quando `ACC ≥ PRE`. Um CTU e um CTD podem usar o mesmo contador.

## Cenas

| Cena | O que tem |
|---|---|
| Painel de treinamento | 5 botões (um NF), 3 chaves, potenciômetro 0–1000 e 8 lâmpadas |
| Partida direta de motor | Botões liga/desliga, relé térmico F1 com sobrecarga simulada e rearme |
| Controle de nível de tanque | Bomba, boias de nível baixo (20%) e alto (80%), transmissor 0–1000 e consumo |
| Esteira com contagem | Motor da esteira, sensor de caixa, botões liga/desliga/reset e alimentação automática |

Cada cena tem exemplos prontos em ST e em Ladder. O botão **?** ao lado da cena explica como ela funciona. Botões NF ficam em 1 em repouso, como no campo.

## Ligar ao Node-RED (Modbus)

O CLP simulado é o **escravo**; o Node-RED (ou outro supervisório) é o **mestre**. O mestre lê entradas, saídas e memória, e só escreve na memória `%M`, como num CLP real.

### Endereços (base 0, como no Node-RED)

| Tabela Modbus | Endereços | No CLP | Mestre |
|---|---|---|---|
| Discrete Inputs (FC 02) | 0–63 | `%IX0.0 … %IX7.7` | lê |
| Coils (FC 01) | 0–63 | `%QX0.0 … %QX7.7` | lê |
| Coils (FC 01/05/15) | 1024–1279 | `%MX0.0 … %MX31.7` | lê e escreve |
| Input Registers (FC 04) | 0–7 | `%IW0 … %IW7` | lê |
| Holding Registers (FC 03) | 0–7 | `%QW0 … %QW7` | lê |
| Holding Registers (FC 03/06/16) | 1024–1055 | `%MW0 … %MW31` | lê e escreve |
| Holding Registers (FC 03/06/16) | 2048–2079 | `%MD0 … %MD15` (2 registradores cada) | lê e escreve |

- **Bits:** endereço = byte × 8 + bit. Exemplo: `%MX0.1` é o coil 1025.
- **16 bits:** valores com sinal; −1 aparece como 65535 se o Node-RED ler “sem sinal”.
- **32 bits (`%MD`):** `%MDn` ocupa os registradores `2048 + 2n` e `2049 + 2n`. Leia e escreva sempre os dois juntos. A ordem das palavras (**ABCD** ou **CDAB**) é escolhida na aba **Comunicação**; se aparecer um número absurdo no Node-RED, troque a ordem.
- A aba **Variáveis** mostra o endereço Modbus de cada variável declarada com `AT`.
- A memória `%M` zera ao entrar em RUN: se o supervisório escreveu um valor com o CLP parado, escreva de novo depois do RUN.
- O exemplo **“Tanque — setpoints pelo supervisório (Modbus)”** está pronto para testar: o Node-RED liga o automático (coil 1024), muda os setpoints em REAL (2048 e 2050) e lê o nível (2052) e o número de partidas da bomba (2054).

### Modbus RTU (porta serial)

1. Instale o **com0com** (versão com driver assinado) e crie um par de portas virtuais, por exemplo `COM10 ⇄ COM11`.
2. No simulador, aba **Comunicação**: confira a serial (padrão 19200 8N1, ID 1), clique em **Conectar porta…** e escolha a `COM10`.
3. No Node-RED (`node-red-contrib-modbus`), crie um cliente **Serial RTU** na `COM11`, com os mesmos parâmetros e o mesmo Unit ID.

Se a `COM10` não aparecer na lista, marque **“use Ports class”** no setup do com0com e reinicie o navegador.

### Modbus TCP

O navegador não recebe conexões TCP, então um pequeno programa, o **gateway**, faz essa ponte no seu computador. Ele precisa do **Node.js**, o mesmo que o Node-RED usa.

1. Baixe o [modbus-gateway.js](https://github.com/andreroberto83/plc-simulator/raw/main/tools/modbus-gateway.js) para uma pasta.
2. Abra um terminal nessa pasta e rode:
   ```
   node modbus-gateway.js
   ```
   Deixe a janela aberta enquanto usa o simulador.
3. No simulador, aba **Comunicação**, clique em **Conectar ao gateway**.
4. O navegador vai pedir permissão para **acessar dispositivos na rede local**. Clique em **Permitir**. Sem isso, a aba mostra “gateway não encontrado”.
5. No Node-RED, crie um cliente **TCP** com host `127.0.0.1` e porta `502`.

Se você negou a permissão por engano: clique no ícone à esquerda do endereço do site, abra as configurações do site e permita o acesso à rede local. Depois recarregue a página.

Outras opções do gateway:

```
node modbus-gateway.js --port 5020     # outra porta TCP para o Node-RED
node modbus-gateway.js --host 0.0.0.0  # aceita supervisórios de outros computadores (o Firewall do Windows vai perguntar)
```

Se a página do simulador estiver fechada, o Node-RED recebe a exceção **0x0B** em vez de ficar esperando. O CLP continua rodando com a aba em segundo plano, então dá para alternar para o Node-RED sem parar o scan.
