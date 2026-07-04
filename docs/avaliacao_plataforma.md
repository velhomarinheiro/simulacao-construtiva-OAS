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

### A.5 Refinamentos de rigor — [CORRIGIDOS P1]

- **Predicado de meios ofensivos** (`E1_kcv`/vitória): `hasOffensiveMeans`
  (`combat_config.js`) passou a exigir arma com estoque ou capacidade ofensiva —
  interceptadores puros (airDefense/bmd) e a tabela `attackRange` não contam. Fonte
  única usada por `checkWinner` e `redForceCombatIneffective`. `E1_kcv` voltou a
  discriminar (4/20 réplicas em C0; vitórias decididas em vez de censuradas).
- **E3 ponderado**: `offensiveStock` pondera cada arma/capacidade pelo dano
  esperado (`weaponOffensiveWeight`), medindo potencial de combate, não contagem.
- **Doutrina de recarga parametrizada**: `state.reloadDoctrine` (`baseline` padrão
  | `symmetric`); a suposição virou parâmetro de cenário declarado.
- **Ruído decisório dos bots**: jitter simétrico (média 1) no argmax de alvo e de
  atribuição, condicionado a `state.rng`; amplia trajetórias entre réplicas sem
  viés. Sem semente → determinístico.
- **Cobertura de testes**: `metrics.test.js` e `game_engine_p1.test.js` (métricas,
  doutrina, ruído e pipeline fim-a-fim); suíte total 70 verdes.

**P1.1 reavaliado e descartado (seria incorreto)**: "ativar staying power e
admissibilidade χ reais" foi analisado e **não** implementado — as tabelas d6 já
expressam dano em pontos absolutos de staying power e a efetividade cruzada de
domínio já está nas `SALVO_KERNELS` por par (arma, alvo); `stayingPower = 1` e χ
permissivo são a ponte **correta**, e alterá-los contaria os efeitos duas vezes,
quebrando as médias calibradas. Detalhe em `pbc_capacidades.md §8.5` e em
comentário em `combat_engine.js`. O maquinário χ/staying-power só se aplicaria a
uma resolução força-contra-força em pulso único (redesenho, não ajuste).

> Os datasets `output/coleta_*.csv` são artefatos gitignored; regenere-os com o
> motor corrigido pelo `batch_runner` (`pbc_capacidades.md §8.6`).

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

### B.5 Correções de plataforma — [APLICADAS P2]

- **Resiliência** (`server.js`): queda de jogador humano agora passa a equipe à
  IA (`room.bots[team]=true` + `runBotsForPhase`, emite `player_ai_takeover`) —
  fim do travamento; queda do facilitador **não** deleta a sala (grace period
  `ROOM_GRACE_MS` com limpeza agendada, cancelada no rejoin); novo evento
  `rejoin_room` reassume a sala. Cobertura em `server_resilience.test.js`.
- **Validação de OB** (`shared/ob_io.js#validateOB`): `update_ob` rejeita OB
  malformada (categoria inválida, id duplicado, SP≤0, posição fora do tabuleiro),
  reportando todos os erros ao facilitador.
- **Lote assíncrono** (`server.js`): `run_batch_simulations` roda em chunks via
  `setImmediate` com eventos `batch_progress`, sem bloquear o event loop.
- **Importação robusta** (`shared/ob_io.js#parseCSV/obFromCsv`): parser em
  máquina de estados sobre o texto todo (campos com aspas e quebras de linha) e
  distinção de `0` vs vazio. Módulo compartilhado navegador+servidor.
- **AAR estruturado**: `state.combatHistory` registra cada engajamento
  (turno, atacante, alvo, arma, dano, destruição); exportável em CSV
  (`exportAarCsv`, botão 📊 AAR) e incluído no log em texto. Facilitador-only.
- **Toque + responsivo**: eventos `touchstart`/`touchend` no canvas espelham o
  mouse; media query (`max-width:860px`) empilha o layout. QA visual por
  Playwright (viewports 390/820): 0 px de overflow horizontal, sidebars
  empilhadas, toque seleciona hex, modal cabe na tela.
- **Formulário de unidade**: os 7 `prompt()` e os textareas de JSON cru foram
  substituídos por um modal estruturado unificado (add/edit, config e ao vivo)
  com seletor de equipe e editores de armas/capacidades por linha
  (`facilitator.js`); edição ao vivo agora aplica todos os campos e limita a
  posição ao tabuleiro no servidor.
- **Timer de turno**: opcional (`room.turnTimerSec`, configurado no start);
  ao expirar, a IA age pela equipe humana pendente (evita travar). Contagem
  regressiva no cabeçalho via evento `turn_deadline`.
- **Mensagens do jogador**: jogadores iniciam mensagens ao facilitador
  (`player_message` + caixa de composição no sidebar), exibidas no log do
  facilitador.
- **Persistência em disco** (`shared/persistence.js`): snapshot das salas em
  JSON (autosave debounced + flush em SIGINT/SIGTERM, escrita atômica) e
  restauração no boot — partidas em andamento **sobrevivem a reinício do
  servidor**. O PRNG seedado agora expõe `.state` (contador serializável,
  `mulberry32FromState`), então o fluxo estocástico **continua exatamente** de
  onde parou. Sockets não são persistidos (efêmeros); clientes reassumem por
  código (rejoin automático via `sessionStorage`). Snapshots com mais de 24 h
  são descartados. Verificado por reinício real do servidor (sala e 57 unidades
  restauradas, facilitador reassumiu).

**P2 pendente** (menor): a tela de configuração do facilitador (editor de OB,
tabela larga) permanece orientada a desktop — o jogo em si é responsivo.

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

**P0 — validade do estudo** — ✅ concluído (§A.1-A.4, `pbc_capacidades.md §6-7`).

**P1 — rigor e método** — ✅ concluído (§A.5, `pbc_capacidades.md §8`); o item
"staying power/admissibilidade" foi reavaliado e descartado por ser incorreto.

**P2 — plataforma, dados e jogabilidade** — ✅ núcleo concluído (§B.5):
reconexão/failover para bot, sala persistente com grace period, validação de OB,
lote assíncrono com progresso, parser CSV multilinha, AAR estruturado, toque +
media query, datasets regenerados.

**P2 residual concluído**: formulário de unidade estruturado, timer de turno,
mensagens iniciadas pelo jogador, QA visual de responsividade/toque e
**persistência em disco** (partidas sobrevivem a reinício do servidor) (§B.5).

**Pendente (menor):** a tela de configuração do facilitador (editor de OB,
tabela larga) permanece orientada a desktop — o jogo em si é responsivo.

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
