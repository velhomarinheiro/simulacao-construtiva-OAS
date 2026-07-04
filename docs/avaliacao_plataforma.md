# Avaliação da Plataforma de Simulação Construtiva

**Objeto**: `simulacao-construtiva-oas` — plataforma que funde o jogo de guerra
"Operação Atlântico Sul" (`prof-wargame-naval`, mecânica d6 em hexágonos) com o
simulador da equação de salva multidomínio (`naval_salvo`, Python/numpy,
portado para JS em `shared/salvo_engine/`), para um estudo comparativo de
capacidades (PBC).

**Escopo**: correção metodológica, rigor, método, interface, design,
importação/exportação de dados, relatórios e jogabilidade.

**Estado das correções**: os itens marcados **[CORRIGIDO P0]** já foram
implementados e testados nesta revisão (ver §6-7 de `pbc_capacidades.md` e
`shared/tests/combat_simultaneity.test.js`). Os demais permanecem como roteiro
priorizado (§C).

---

## Sumário executivo

A plataforma é sólida em engenharia: o porte do simulador de salva é fiel à
referência (recupera Hughes 1995 e Johns-Pilnick-Hughes 2001 com precisão de
máquina nos testes), a calibração d6→valor esperado preserva a média das
tabelas originais, há reprodutibilidade por semente e uma suíte de testes nas
camadas baixas. A documentação em `docs/pbc_capacidades.md` é honesta quanto às
limitações das métricas.

Para uso como instrumento de estudo PBC, esta revisão identificou quatro
problemas metodológicos que comprometiam a validade dos resultados antes de
qualquer análise estatística. **Três deles (fila de combate pró-Azul, viés de
overkill, interceptação sem saturação) foram corrigidos** com resolução
simultânea de combate; o quarto (Common Random Numbers) foi **documentado** com
orientação de análise pareada. Permanece um conjunto de melhorias de rigor
(P1) e de plataforma/UX (P2) descritas ao final.

---

## Metodologia da avaliação

Leitura integral do código das três frentes — motor de simulação
(`shared/salvo_engine/`, `combat_engine.js`, `game_engine.js`, `metrics.js`,
`bot/`), camada de interface e dados (`server.js`, `public/`), e os dois
repositórios de referência (`prof-wargame-naval`, `naval_salvo`) — cruzando as
afirmações da documentação com o comportamento real do código. As correções
foram verificadas por testes unitários dedicados e por execução end-to-end do
`tools/batch_runner.js` (comparação pareada de 50 réplicas antes/depois).

---

## A. Correção metodológica

### A.1 Simultaneidade do combate — [CORRIGIDO P0]

`resolveCombatQueue` resolvia a fila `[...Azul, ...Vermelho]` mutando
`defender.hp` imediatamente; um ataque azul que matava uma unidade vermelha
cancelava o ataque de retorno já declarado por ela. Como o Azul é sempre
enfileirado primeiro e é o lado cujas capacidades o estudo varia, isso enviesava
sistematicamente todas as métricas. **Correção**: nenhum HP muda até toda a fila
ser resolvida — toda unidade viva no início da fase dispara, o dano é somado por
defensor e aplicado ao final (troca simultânea, como em `salvo_engine/dynamics.js`).
Efeito medido (C0, 50 réplicas pareadas): atrito Vermelho −0,96, atrito Azul
+1,52 — a direção esperada ao remover o golpe grátis.

### A.2 Viés de overkill (determinístico × estocástico) — [CORRIGIDO P0]

`min(rawKernel, hp)` por engajamento tornava o modo estocástico enviesado para
baixo sob overkill (`E[min(amostrado,hp)] ≤ min(E[amostrado],hp)`), e os
datasets determinístico e estocástico não eram intercambiáveis. **Correção**: o
dano é somado por defensor e clipado uma única vez no agregado
(`min(Σ incidente, SP_início)`), a semântica "agrega-antes-do-max" do próprio
modelo, com atribuição proporcional por engajamento. Resíduo documentado: os
modos ainda divergem nas fronteiras (piso de vazadores + teto de SP); a
recomendação é usar um único modo por dataset.

### A.3 Saturação da interceptação — [CORRIGIDO P0]

`airDefense`/`bmd` (não-expendíveis) faziam cada atacante enfrentar a bateria
defensiva **completa e renovada** em engajamento separado, multiplicando a
defesa pelo número de atacantes e invertendo a dinâmica de saturação que a
equação de salva existe para capturar. **Correção**: a interceptação passou a
ser um pool compartilhado por defensor e por fase (`interceptBudget`); ataques
concentrados saturam a defesa. Não deplete estoque entre turnos (defesas AA são
reutilizáveis), apenas satura dentro de uma troca de salvas.

### A.4 Common Random Numbers entre condições — [DOCUMENTADO P0]

`tools/conditions.js` reutiliza o mesmo conjunto de sementes em todas as
condições (7001-7020 fatorial; 5001-5050 ablação). É redução de variância
deliberada (bom), mas induz correlação positiva entre condições no mesmo índice
de réplica — logo as análises que assumem independência (teste t de duas
amostras, ANOVA entre-sujeitos) ficam mal especificadas. Documentado em
`pbc_capacidades.md §7` com a recomendação de métodos pareados/blocados (teste t
pareado / Wilcoxon, ANOVA de medidas repetidas, Cohen's dz) **ou** sementes
disjuntas por condição.

### A.5 Questões metodológicas remanescentes (não-P0)

- **Maquinário do salvo_engine parcialmente inerte**: o engajamento 1-vs-1 ainda
  força `stayingPower = 1` e admissibilidade toda-1; a matriz χ 5×5 e o targeting
  σ não são exercitados na resolução do jogo. O combate efetivo permanece
  `pOffense·tiros − pDefense`. Ativar staying power e admissibilidade reais é P1.
- **Bots determinísticos**: nenhum módulo de `shared/bot/` consome `state.rng`
  (contrariando `rng.js:14`); a única fonte de variância é a amostragem de dano.
  A variância entre réplicas é estruturalmente estreita. Ruído decisório opcional
  via `state.rng` é P1.
- **Métricas-proxy**: `E1_kcv` conta capacidade defensiva (airDefense/bmd/asw)
  como "ofensa" no predicado de vitória (`game_engine.js#checkWinner`);
  `E3_culminancia` soma munições com inteiros de capacidade sem pesos e, como
  o Vermelho de superfície nunca recarrega, mede sobretudo gasto de mísseis. São
  proxies auto-declarados; refino e ponderação são P1.
- **Recarga assimétrica hardcoded** (Azul recarrega amplamente; superfície/
  submarino Vermelho nunca) — suposição doutrinária de grande efeito, deveria
  ser parâmetro de cenário declarado (P1).
- **Lacunas de teste**: `metrics.js` e o `batch_runner` fim-a-fim seguem sem
  teste; sem validação estatística dos datasets (P1).

---

## B. Interface, design, dados e jogabilidade

### B.1 Persistência e resiliência (mais grave)

- Tudo em memória (`server.js:30`); reinício do servidor apaga todas as partidas.
- Desconexão do facilitador **deleta a sala** para ambos os jogadores
  (`server.js:476`).
- Queda de jogador humano **não** ativa o bot para o time (`room.bots` só é
  definido em `start_game`) → a partida **trava** esperando um commit que nunca
  vem (`server.js:466-477`).
- Sem auto-rejoin: reconexão exige redigitar código e time; movimentos planejados
  não commitados são perdidos.

### B.2 Validação de entrada e robustez do servidor

- `update_ob` armazena a OB do cliente sem validação de schema (`server.js:251`);
  `facilitator_manage_unit` confia no payload (`:414`); posição em edição não é
  limitada aos bounds (`:427`).
- O lote de até 200 partidas roda **síncrono no event loop** (`:286-290`),
  congelando todas as salas durante a execução. CORS `*` (`:24`).

### B.3 Importação/exportação e relatórios

- Exporta PNG do mapa, log em texto, OB em CSV (com BOM e escaping corretos) e
  resultados de lote em CSV. Importa apenas OB CSV.
- Parser de importação é single-line: campos com quebra de linha quebram o
  arquivo (`export.js:143-162`); `Number()||default` reescreve `0` legítimo
  (`:179,191`); sem checagem de bounds col/row na importação.
- **Sem AAR estruturado**: o log de batalha é truncado nas 50 linhas mais
  recentes (`server.js:93`); os resultados por engajamento do painel de combate
  são descartados após exibição; resultados de lote vivem só na memória do
  navegador até exportação manual.

### B.4 Jogabilidade e acessibilidade

- Desktop-only: zero media queries, zero touch handlers, fontes ~10px, layout
  fixo de 3 colunas (`public/css/game.css`). Inutilizável em toque/mobile.
- Fricção: adição de unidade via 7 `prompt()` encadeados
  (`facilitator.js:493-510`); edição de armas por textarea de JSON cru
  (`game.html:202-206`); jogadores só respondem a mensagens do facilitador,
  nunca as iniciam; sem timer de turno; undo só do último passo do trajeto atual.
- Regras ensinadas apenas pela lista estática da landing page; sem tutorial ou
  tooltips em jogo.

---

## Pontos fortes

- **Fidelidade do porte**: `shared/salvo_engine/dynamics.js` reproduz a semântica
  canônica (agrega-antes-do-clip, troca simultânea, perdas ÷ staying power), com
  recuperação numérica de Hughes/JPH nos testes.
- **Calibração rastreável**: `SALVO_KERNELS` deriva das tabelas d6 originais por
  valor esperado (E['1d6']=3.5) — auditável em `combat_config.js`.
- **Reprodutibilidade**: `mulberry32` seedado, semente exposta na UI e registrada
  por réplica no CSV.
- **Desenho experimental**: fatorial 2⁵ + ablação leave-one-out
  (`tools/conditions.js`), runner headless de 940 partidas.
- **Honestidade documental**: proxies e desvios do briefing são declarados.

---

## C. Roteiro priorizado remanescente

**P1 — rigor e método**
1. Ativar staying power e admissibilidade χ reais no engajamento (remover o
   `stayingPower=1` forçado; usar a matriz canônica em vez da permissiva).
2. Ruído decisório opcional nos bots consumindo `state.rng` (desempate
   estocástico de alvos/rotas) para ampliar o espaço de trajetórias.
3. Corrigir o predicado de `E1_kcv`/vitória (separar meios ofensivos de
   defensivos) e ponderar a `E3`; parametrizar a doutrina de recarga.
4. Teste fim-a-fim do `batch_runner` + `metrics.js`.

**P2 — plataforma, dados e jogabilidade**
5. Persistência (SQLite ou snapshot JSON) + reconexão com grace period e
   failover automático para bot; não deletar a sala na queda do facilitador.
6. AAR estruturado: registro por engajamento (JSON/CSV) e relatório imprimível;
   log sem truncamento.
7. Formulário de unidade substituindo prompts/JSON cru; validação de schema da
   OB no servidor; parser CSV multilinha e distinção `0` vs vazio.
8. Lote assíncrono (worker) com progresso; timer de turno opcional;
   responsividade e eventos touch básicos.

---

## Apêndice — valores de calibração (derivados das tabelas d6)

`pOffense` = valor esperado da tabela d6 do `damageProfile` (E['1d6']=3,5):

| Arma / perfil | Alvo | pOffense (dano esperado/tiro) |
|---|---|---|
| `ascmSurface` | surface | 1,75 |
| `mssSurface` | surface | 1,083 |
| `torpedo` | surface/submarine | 1,333 |
| `lacm` | land | 1,5 |
| `asbmSurface` | surface | 1,75 |
| `navalGun` | surface / land | 0,667 / 0,5 |
| `airDefense`/`bmd` | missile (p. intercepção) | 0,333 |
| `asw` | submarine | 0,75 |
| `airAttack` | surface / air / land | 1,333 / 0,917 / 0,917 |

Referências do modelo: Hughes (1995), Johns-Pilnick-Hughes (2001),
Armstrong (2005/2014), Hausken & Moxnes (2026).
