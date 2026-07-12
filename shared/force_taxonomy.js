'use strict';

/**
 * force_taxonomy.js
 * =================
 *
 * Camada 2 (componentes de força de Coutau-Bégarie, Traité de stratégie navale
 * item 350) + análogos aéreo/terrestre/ciber: agrupa os meios do cenário
 * Operação Atlântico Sul por domínio e grupo de capacidade. Fonte única da
 * verdade para ordenação da OB, MOEs por componente e organização da UI.
 *
 * Espelha shared/force_taxonomy.json (o artefato portável/canônico); um teste
 * (shared/tests/force_taxonomy.test.js) trava os dois em igualdade estrutural.
 * UMD: require() em Node e global (window.FORCE_TAXONOMY) no navegador — servido
 * em /shared/force_taxonomy.js.
 *
 * Decisão de cenário: BLUE-SAG-P (Azul) e RED-GE-1 / ESCCSG (Vermelho) entram em
 * INTERV (intervenção). Ativos protegidos (FPSO/porto/aeródromo) e qualquer
 * unidade não listada caem no fallback INFRA.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FORCE_TAXONOMY = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {

  // Ordem doutrinária dos domínios (para taxonomyOrder e agrupamento na UI).
  const DOMAIN_ORDER = ['⚓ Naval — Superfície', '🌊 Naval — Submarino', '✈️ Aéreo', '🏔️ Terrestre', '⚡ Cibernético'];

  const DOMAINS = {
    NAV_SURF: '⚓ Naval — Superfície', NAV_SUB: '🌊 Naval — Submarino',
    AIR: '✈️ Aéreo', LAND: '🏔️ Terrestre', CYBER: '⚡ Cibernético',
    INFRA: '🏭 Infraestrutura crítica',
  };

  const INFRA = { domain: DOMAINS.INFRA, sigla: 'INFRA', label: 'Infraestrutura crítica (ativos protegidos)' };

  // Espelho de force_taxonomy.json#taxonomia (travado por teste).
  const TAXONOMY = {
    blue: [
      { domain: '⚓ Naval — Superfície', groups: [
        { sigla: 'INTERV', label: 'Intervenção (grupo aeronaval)', units: ['BLUE-SAG-P'] },
        { sigla: 'VIG', label: 'Vigilância (escolta oceânica)', units: ['BLUE-SAG-S1', 'BLUE-SAG-S2'] },
        { sigla: 'ANF', label: 'Anfíbia', units: ['BLUE-ANFIB'] },
        { sigla: 'COST', label: 'Costeira (patrulha)', units: ['BLUE-PAT-O1', 'BLUE-PAT-O2', 'BLUE-PAT-C1', 'BLUE-PAT-C2'] },
        { sigla: 'LOG', label: 'Logística (trem de esquadra)', units: ['BLUE-LOG-A', 'BLUE-LOG-T'] },
      ] },
      { domain: '🌊 Naval — Submarino', groups: [
        { sigla: 'DISS', label: 'Dissuasão (negação do mar)', units: ['BLUE-SUB-N', 'BLUE-SUB-1', 'BLUE-SUB-2', 'BLUE-SUB-3'] },
      ] },
      { domain: '✈️ Aéreo', groups: [
        { sigla: 'DAE', label: 'Defesa aérea / superioridade', units: ['BLUE-CACA-1', 'BLUE-CACA-2'] },
        { sigla: 'PATMAR', label: 'Patrulha marítima e ISR', units: ['BLUE-MPRA-1', 'BLUE-MPRA-2'] },
        { sigla: 'ATQ', label: 'Ataque aeronaval', units: ['BLUE-CJAT-1', 'BLUE-CJAT-2'] },
      ] },
      { domain: '🏔️ Terrestre', groups: [
        { sigla: 'DCOST', label: 'Defesa costeira (A2/AD)', units: ['BLUE-DCOST1', 'BLUE-DCOST2'] },
        { sigla: 'GBAD', label: 'Defesa antiaérea', units: ['BLUE-ADA-1', 'BLUE-ADA-2'] },
        { sigla: 'OPESP', label: 'Operações especiais', units: ['BLUE-SEOP'] },
      ] },
    ],
    red: [
      { domain: '⚓ Naval — Superfície', groups: [
        { sigla: 'INTERV', label: 'Intervenção (grupo de batalha)', units: ['RED-GBPA', 'RED-GE-1'] },
        { sigla: 'VIG', label: 'Vigilância (escoltas)', units: ['RED-GE-2', 'RED-GE-3'] },
        { sigla: 'ANF', label: 'Anfíbia', units: ['RED-GANF'] },
        { sigla: 'LOG', label: 'Logística', units: ['RED-AOR-G', 'RED-GLOG', 'RED-AKE'] },
      ] },
      { domain: '🌊 Naval — Submarino', groups: [
        { sigla: 'DISS', label: 'Dissuasão (negação do mar)', units: ['RED-KSN', 'RED-KS-1'] },
      ] },
      { domain: '✈️ Aéreo', groups: [
        { sigla: 'DAE', label: 'Caça embarcada', units: ['RED-KMF-1', 'RED-KMF-2'] },
        { sigla: 'PATMAR', label: 'Patrulha marítima e AEW', units: ['RED-MPRA-K1', 'RED-MPRA-K2', 'RED-AWACS-K'] },
      ] },
      { domain: '🏔️ Terrestre', groups: [
        { sigla: 'OPESP', label: 'Operações especiais', units: ['RED-SEOP', 'RED-SEOP-2'] },
      ] },
    ],
  };

  // unitId -> {domain, sigla, label} (index construído uma vez por lado).
  const _index = {};
  function indexFor(side) {
    if (_index[side]) return _index[side];
    const idx = new Map();
    for (const dom of (TAXONOMY[side] || [])) {
      for (const grp of dom.groups) {
        for (const unitId of grp.units) idx.set(unitId, { domain: dom.domain, sigla: grp.sigla, label: grp.label });
      }
    }
    return (_index[side] = idx);
  }

  /**
   * Classifica um meio no seu (domínio, grupo). Ativos protegidos e qualquer
   * unidade não listada caem no fallback INFRA.
   * @returns {{domain:string, sigla:string, label:string}}
   */
  function classifyUnit(unitId, side = 'blue') {
    const hit = indexFor(side).get(unitId);
    return hit ? hit : { domain: INFRA.domain, sigla: INFRA.sigla, label: INFRA.label };
  }

  /**
   * Mapa unitId -> índice sequencial na ordem doutrinária (domínio → grupo →
   * posição). Unidades não listadas recebem índices ao final (ordem estável de
   * chegada), para ordenar tabelas sem quebrar em ativos INFRA.
   */
  function taxonomyOrder(side = 'blue') {
    const order = new Map();
    let i = 0;
    const doms = [...(TAXONOMY[side] || [])].sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain));
    for (const dom of doms) for (const grp of dom.groups) for (const unitId of grp.units) order.set(unitId, i++);
    return order;
  }

  /**
   * [{sigla,label,domain}] na ordem da taxonomia; acrescenta INFRA ao final
   * (para o lado com ativos protegidos). Para rotular linhas de MOEs/tabelas.
   */
  function groupLabels(side = 'blue') {
    const out = [];
    const doms = [...(TAXONOMY[side] || [])].sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain));
    for (const dom of doms) for (const grp of dom.groups) out.push({ sigla: grp.sigla, label: grp.label, domain: dom.domain });
    out.push({ sigla: INFRA.sigla, label: INFRA.label, domain: INFRA.domain });
    return out;
  }

  return { TAXONOMY, DOMAINS, DOMAIN_ORDER, INFRA, classifyUnit, taxonomyOrder, groupLabels };
});
