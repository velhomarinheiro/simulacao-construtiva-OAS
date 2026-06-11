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
| `shared/capability_factors.js` | Mapeia os 5 fatores de capacidade para unidades da OB, custos EAC e a unidade-KCV; `applyCapabilityConfig(ob, factors)` remove unidades das capacidades "desligadas". |
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

## 2. KCV Aurelius Magnus

`RED-GBPA` (CSG — Carrier Strike Group Vermelho) foi adotado como o "KCV
Aurelius Magnus". `shared/game_engine.js#checkWinner` agora verifica esta
unidade **antes** da condição genérica de exaustão ofensiva: se
`RED-GBPA.hp <= 0`, o jogo termina imediatamente com vitória Azul decisiva
(`E1_kcv = 1`).

## 3. Métricas (E1/E2/E3 + M Dsp)

Implementadas em `shared/metrics.js`, calculadas a partir do estado final:

- **E1_atrito** — soma de `(maxHp - hp)` de todas as unidades Vermelhas.
- **E1_kcv** — `1` se `RED-GBPA` foi destruído (decisivo), senão `0`.
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

## 5. Limitação importante: determinismo e réplicas

O motor de combate (`shared/combat_engine.js`) usa a **equação de salva
determística** (núcleos de valor esperado, calibrados contra as tabelas de
dano dos Apêndices A-B pela suíte de 60 testes existente) — não consome
`Math.random()`. O motor de decisão (`shared/bot/decision_engine.js`) também
é determinístico (sempre escolhe o alvo de maior `attackScore`).

Consequência: **com os fatores de capacidade fixos, todas as réplicas de uma
mesma condição produzem hoje o mesmo resultado** — a semente
(`shared/rng.js`, `mulberry32`) é registrada no dataset para reprodutibilidade,
mas ainda não introduz variância entre réplicas.

Isso satisfaz o critério de aceitação "mesmo seed → mesmo resultado", mas
**não é suficiente** para as análises estatísticas do Apêndice G (teste t,
Mann-Whitney, ANOVA, Cohen's d), que pressupõem variação amostral entre
réplicas. Próximo passo recomendado: introduzir uma fonte de variação
controlada e seedada via `shared/rng.js` — por exemplo, a **equação de salva
estocástica** do briefing (`E[vazadas] = ...`, sorteando interceptações/acertos
por tiro) como alternativa ao núcleo de valor esperado, e/ou desempates
estocásticos de alvo no `decision_engine`. Essa mudança não foi feita nesta
sessão por afetar a calibração coberta pelos 60 testes existentes — fica como
decisão de projeto a ser validada com o orientador antes de alterar o motor
de combate.
