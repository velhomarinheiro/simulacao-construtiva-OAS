# Adaptação para Comparação de Capacidades (PBC)

Este documento descreve os ajustes feitos em `simulacao-construtiva-oas` para
suportar o estudo de comparação de capacidades descrito em
`briefing_construcao_ferramenta.md`, `Apêndice F`, `Projeto de Pesquisa
v3.0` e `matriz_fatorial_2a5.xlsx` (delineamento de ablação + fatorial 2^5).

A implementação permanece em **JavaScript/Node**, reaproveitando o motor de
combate (equação de salva, `shared/combat_engine.js` /
`shared/salvo_engine/`), a Ordem de Batalha (`shared/order_of_battle.js`) e o
motor de decisão (`shared/bot/decision_engine.js`) já existentes — em vez da
stack TypeScript sugerida no briefing (§10), conforme solicitado ("adequar a
este projeto").

## Arquivos novos/alterados

| Arquivo | O que faz |
|---|---|
| `shared/capability_factors.js` | Mapeia os 5 fatores de capacidade para unidades da OB e custos EAC; `applyCapabilityConfig(ob, factors)` remove unidades das capacidades "desligadas". |
| `shared/rng.js` | PRNG seedado (`mulberry32`), conforme briefing §13. |
| `shared/metrics.js` | Calcula `E1_atrito`, `E1_kcv`, `E2_vp`, `E2_sloc`, `E3_culminancia`, `atrito_azul` a partir do estado final do jogo. |
| `shared/game_engine.js` | **Novo** — motor de jogo headless (sem Socket.io), extraído de `server.js`. Usado tanto pelo servidor multiplayer quanto pelo runner em lote. |
| `server.js` | Refatorado para chamar `shared/game_engine.js`; comportamento multiplayer inalterado (suíte de 60 testes permanece verde). |
| `tools/conditions.js` | Gera as 32 condições do fatorial 2^5 (`Cond_01..Cond_32`) e as 6 condições de ablação (`C0..C5`), com sementes/réplicas conforme o protocolo do dicionário. |
| `tools/batch_runner.js` | CLI que joga partidas headless bot-vs-bot e grava CSVs no formato `Coleta_Fatorial`/`Coleta_Ablacao`. |

## 1. Os 5 fatores de capacidade

| Fator | Custo (EAC) | Unidades removidas quando "ausente" |
|---|---|---|
| `A_SSN` — Submarino nuclear | 100 | `BLUE-SUB-N` |
| `B_SSK` — Submarinos convencionais | 31 | `BLUE-SUB-1`, `BLUE-SUB-2`, `BLUE-SUB-3` |
| `C_Azuis` — Controle de Águas Azuis | 78 | `BLUE-SAG-S1`, `BLUE-SAG-S2` |
| `D_MSS` — Patrulha armada com MSS | 27 | `BLUE-PAT-O1`, `BLUE-PAT-O2`, `BLUE-PAT-C1`, `BLUE-PAT-C2` |
| `E_Terra` — Negação terrestre (defesa costeira) | 12 | `BLUE-DCOST1`, `BLUE-DCOST2` |

Custo total com todas presentes = 248 (bate com `custo_total` da condição C0
da aba `Coleta_Ablacao`). `BLUE-SAG-P` (grupo aeronaval principal) permanece
constante em todas as condições — não está atrelado a nenhum dos 5 fatores,
representando o "núcleo" sempre presente da Força Azul. ISR (sensores,
detecção) também permanece constante, conforme exigido (briefing §7).

## 2. Condição de vitória decisiva

A destruição de uma unidade específica (ex.: `RED-GBPA`, o "KCV Aurelius
Magnus" / CSG Vermelho) **não** é mais, isoladamente, condição de vitória.
`shared/game_engine.js#checkWinner` define vitória decisiva pela exaustão
ofensiva geral de um lado: um lado perde quando nenhuma de suas unidades
sobreviventes mantém qualquer meio ofensivo (`attackRange`, estoque de
armas ou capacidade ofensiva > 0). Ou seja, a medida de "decisivo" passou a
refletir a redução de capacidade / destruição dos meios Vermelhos **em
geral**, e não a perda de um navio específico.

## 3. Métricas (E1/E2/E3 + M Dsp)

Implementadas em `shared/metrics.js`, calculadas a partir do estado final:

- **E1_atrito** — soma de `(maxHp - hp)` de todas as unidades Vermelhas.
- **E1_kcv** — `1` se as forças Vermelhas como um todo foram reduzidas a
  incapacidade de combate (nenhuma unidade sobrevivente com meio ofensivo
  > 0 — mesma condição de vitória decisiva descrita na seção 2), senão `0`.
  ⚠️ proxy: o nome da coluna (`E1_kcv`) é mantido por compatibilidade com
  `matriz_fatorial_2a5.xlsx`, mas a métrica não está mais ligada a uma
  unidade específica.
- **E2_vp** — soma do `hp` restante de `BLUE-FPSO1..4` (infraestrutura
  crítica preservada).
- **E2_sloc** — índice `[0,1]` = `hp/maxHp` agregado dos portos
  (`BLUE-PORTO-S/RJ/V/ACU`), proxy de segurança das SLOC.
- **E3_culminancia** — primeiro turno em que o "estoque ofensivo" Vermelho
  (soma de munições + capacidades ofensivas das unidades vivas) cai para
  ≤50% do nível do turno 1. `null` se isso nunca ocorre ("censurado").
- **atrito_azul** (M Dsp) — soma de `(maxHp - hp)` de todas as unidades
  Azuis.

> ⚠️ **Definições de E2_sloc e E3_culminancia são proxies operacionais**
> derivados do estado de jogo disponível, pois os documentos-fonte não
> especificam uma fórmula determinística. Recomenda-se validação por
> especialistas (Apêndice F §F.10 — validação de fachada) antes do uso
> analítico definitivo.

## 4. Runner em lote (`tools/batch_runner.js`)

Cada partida roda headless: ambos os lados são jogados pelo
`shared/bot/decision_engine.js` via `shared/game_engine.js` (mesma máquina de
estados do `server.js`, sem Socket.io), sem intervenção de facilitador
(aprovações automáticas, sem overrides).

```bash
# Uma condição, poucas réplicas (teste rápido)
node tools/batch_runner.js --bloco fatorial --cond Cond_05 --replicas 2

# Bloco completo (32 condições x 20 réplicas = 640 jogos)
node tools/batch_runner.js --bloco fatorial --out output/coleta_fatorial.csv

# Bloco de ablação completo (6 condições x 50 réplicas = 300 jogos)
node tools/batch_runner.js --bloco ablacao --out output/coleta_ablacao.csv
```

As 940 partidas (640 + 300) rodam em segundos (engine determinístico, sem
I/O de rede). O CSV de saída segue as colunas de `Coleta_Fatorial` /
`Coleta_Ablacao` do `matriz_fatorial_2a5.xlsx`
(`Cond`/`Cond_Abl`, `A_SSN..E_Terra` como `+1/-1`, `n_capacidades`,
`custo_total`, `E1_atrito`, `E1_kcv`, `E2_vp`, `E2_sloc`, `E3_culminancia`,
`atrito_azul`), com colunas extras `ID`, `Replica`, `Semente` e `vencedor`.

## 5. Variância estocástica entre réplicas

O motor de combate (`shared/combat_engine.js`) usa, por padrão, a **equação
de salva determinística** (núcleos de valor esperado, calibrados contra as
tabelas de dano dos Apêndices A-B pela suíte de 60 testes existente). Quando
`newGame(ob, { seed })` recebe uma semente, `state.rng` passa a ser um PRNG
seedado (`shared/rng.js#mulberry32`) e cada `resolveEngagement(...)` passa a
amostrar um resultado **estocástico** por engajamento, em vez de aplicar
diretamente o valor esperado:

1. Para cada interceptador elegível do defensor, sorteia-se um resultado
   0/1 por tiro a partir da própria linha `D6_DAMAGE_TABLES[...].missile`
   usada para calibrar `pDefense` (soma = `intercepted`).
2. `leakers = max(0, launched - intercepted)`.
3. Para cada "vazador", sorteia-se o dano a partir de
   `D6_DAMAGE_TABLES[damageProfile][targetCategory]` (entradas `0`, inteiro
   ou `'1d6'`), somando-se `sampledLoss`.
4. `actualLoss = min(sampledLoss, hp_atual)` é o valor efetivamente aplicado
   a `defender.hp` (registrado em `result.actualLoss`/`result.stochastic`).

Por construção, `E[actualLoss] == expectedLoss` (o núcleo de valor esperado
original, ainda calculado e reportado em `result.expectedLoss`) — ou seja, a
calibração coberta pela suíte de 60 testes não é alterada, apenas passa a
existir variância amostral entre réplicas de uma mesma condição.

**Compatibilidade**: `rng` é um parâmetro opcional de `resolveEngagement` e
`options.seed` é opcional em `newGame`. O modo multiplayer (`server.js`)
nunca passa `seed`, então `state.rng === null` e o combate permanece
**determinístico e idêntico ao comportamento anterior** (todas as 60+ testes
originais, que não passam `rng`, continuam verdes).

**Réplicas em lote**: `tools/batch_runner.js` agora chama
`GE.newGame(customOB, { seed })` com a semente de cada réplica (registrada na
coluna `Semente` do CSV, como antes). Isso satisfaz o critério "mesmo seed →
mesmo resultado" **e** introduz variação amostral entre réplicas distintas da
mesma condição — pré-requisito para as análises estatísticas do Apêndice G
(teste t, Mann-Whitney, ANOVA, Cohen's d).

Testes adicionais cobrindo o novo comportamento estão em
`shared/tests/combat_engine.test.js` (determinismo por seed, variação entre
seeds, `E[actualLoss] ≈ expectedLoss`) e
`shared/tests/game_engine_rng.test.js` (wiring de `state.rng` via
`newGame`/`resolveQueuedEngagement`).

## 6. Resolução simultânea de combate (correções metodológicas P0)

Três correções alinham a resolução de combate à semântica da equação de salva
que o motor (`shared/salvo_engine/dynamics.js`) já implementa, removendo vieses
sistemáticos que afetavam todas as métricas do estudo. Todas foram validadas
por testes (`shared/tests/combat_simultaneity.test.js`) e end-to-end pelo
`batch_runner`.

### 6.1 Simultaneidade (fim do primeiro-ataque pró-Azul)

**Antes**: `resolveCombatQueue` percorria a fila `[...blueAtaques,
...vermelhoAtaques]` aplicando dano a `defender.hp` imediatamente. Como o Azul
é sempre enfileirado primeiro (`buildCombatQueue`), um ataque azul que destruía
uma unidade vermelha **cancelava o ataque de retorno já declarado** por ela no
mesmo turno (o engajamento cancelava-se porque o atacante passava a ter
`hp <= 0`). Isso dava ao Azul — o lado cujas capacidades o estudo varia — um
primeiro golpe grátis, enviesando E1_atrito, atrito_azul, E2 e E3.

**Depois**: nenhum HP muda até que **toda** a fila seja resolvida. Toda unidade
viva no início da fase dispara; o dano incidente é somado por defensor e
aplicado de uma só vez ao final. Uma unidade destruída neste turno ainda
entrega seu fogo declarado — como na troca simultânea de salvas.

Efeito medido (condição C0, 50 réplicas pareadas, sementes 5001-5050):
atrito Vermelho 66,58 → 65,62 (Δ −0,96); atrito Azul 69,36 → 70,88 (Δ +1,52) —
exatamente a direção esperada ao remover o golpe grátis do Azul.

### 6.2 Clip agregado de overkill (modos determinístico × estocástico)

**Antes**: cada engajamento aplicava `min(rawKernel, hp)` isoladamente. Com o
`min` por engajamento, `E[min(amostrado, hp)] ≤ min(E[amostrado], hp)` sempre
que o alvo pudesse ser sobre-destruído (unidades de SP baixo, comum). O modo
estocástico ficava enviesado para baixo frente ao determinístico, e os dois
datasets **não eram intercambiáveis**.

**Depois**: o dano incidente é somado por defensor e clipado **uma única vez**
no agregado, `min(Σ incidente, SP_início_de_fase)` — a mesma semântica
"agrega-antes-do-max" da equação de salva (`dynamics.js`). O dano aplicado é
então atribuído proporcionalmente a cada engajamento (`Σ actualLoss ==
aplicado`) para exibição/log. Isso elimina o viés de overkill *por engajamento*.

Resíduo (documentado, não corrigível sem alterar o modelo): permanece uma
pequena discrepância determinístico-vs-estocástico apenas nas **fronteiras** —
o piso `leakers = max(0, launched − intercepted)` introduz viés para cima e o
teto de SP introduz viés para baixo; no interior (sem saturação de
interceptação, sem overkill) os dois modos coincidem em esperança.
**Recomendação**: para um dado dataset, use **um único modo** de forma
consistente (todo determinístico ou todo estocástico); não misture nem compare
diretamente réplicas determinísticas com estocásticas.

### 6.3 Saturação da bateria de interceptação

**Antes**: `airDefense`/`bmd` são não-expendíveis e cada atacante era resolvido
em engajamento separado usando `min(launched, defQty)` — de modo que N
atacantes no mesmo turno enfrentavam, cada um, a bateria defensiva **completa e
renovada**. A defesa era efetivamente multiplicada pelo número de atacantes,
invertendo a dinâmica de saturação que a equação de salva existe para capturar.

**Depois**: a capacidade de interceptação é um **pool compartilhado por
defensor e por fase** (`interceptBudget`). O primeiro salvo consome
`min(launched, remaining)` interceptores e decrementa o pool; salvos seguintes
enfrentam apenas o que restou. Ataques concentrados podem, assim, saturar a
defesa. O pool não deplete o estoque entre turnos (defesas AA são reutilizáveis
turno a turno); apenas satura dentro de uma mesma troca de salvas. Sem pool
(chamada direta a `resolveEngagement`), o comportamento legado — bateria cheia —
é preservado, mantendo a suíte de testes de engajamento único verde.

### 6.4 Retrocompatibilidade

`interceptBudget` e `applyDamage` são parâmetros **opcionais** de
`resolveEngagement` (padrões: sem pool, aplica dano imediatamente), e
`resolveQueuedEngagement(state, engagement)` chamado com dois argumentos
mantém o modo de aplicação imediata. Assim, o multiplayer interativo
(`server.js`, que chama `resolveCombatQueue`) passa a usar o modo simultâneo,
enquanto todos os testes existentes (57, incluindo os de chamada direta)
permanecem verdes.

## 7. Advertência estatística: Common Random Numbers (CRN) entre condições

`tools/conditions.js` **reutiliza o mesmo conjunto de sementes em todas as
condições** (fatorial 7001-7020; ablação 5001-5050). Isso é uma técnica
deliberada de redução de variância (CRN): comparar condições no mesmo índice de
réplica cancela a variação da "sorte" comum e aumenta o poder para detectar o
efeito das capacidades.

**Consequência**: as réplicas de índice igual **não são independentes** entre
condições — são positivamente correlacionadas. As análises que assumem amostras
independentes (teste t de duas amostras, Mann-Whitney, ANOVA entre-sujeitos)
ficam **mal especificadas** se aplicadas diretamente.

**Recomendação**: trate a semente como bloco e use métodos **pareados/blocados**
— teste t pareado ou Wilcoxon de postos com sinais (duas condições), ANOVA de
medidas repetidas / modelo misto com a semente como efeito aleatório (várias
condições), e Cohen's dz (não d) para tamanho de efeito. Alternativamente, para
usar métodos independentes, gere sementes **disjuntas** por condição em
`conditions.js` (sacrificando a redução de variância do CRN). O repositório não
executa a análise; qualquer script downstream deve declarar explicitamente qual
das duas rotas adota.
