'use strict';

// ─── Terrain type constants ──────────────────────────────────────────────────
const T_LAND    = 0;  // Área Terrestre       — impassável
const T_SHALLOW = 1;  // Águas Rasas <200m    — sem submarinos
const T_SHELF   = 2;  // Plataforma Continental
const T_DEEP    = 3;  // Águas Profundas      — subs ganham furtividade
const T_OIL     = 4;  // Bacia Petrolífera    — objetivo estratégico

// ─── Terrain map 16 × 10 — flat-top hexagons, odd-q offset ─────────────────
//  Col: O → P  (0=costa, 15=Atlântico aberto)
//  Row: N → S  (0≈18°S/Vitória, 9≈30°S/Sul)
//
//   0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15  ← col
const TERRAIN_MAP = [
  [0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3],  // row 0  ~18°S Vitória/ES
  [0, 0, 0, 0, 0, 1, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3],  // row 1
  [0, 0, 0, 0, 1, 1, 2, 4, 3, 3, 3, 3, 3, 3, 3, 3],  // row 2  ~21°S  ★PLT-05
  [0, 0, 0, 1, 1, 2, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3],  // row 3  ~22°S  ★PLT-03/04
  [0, 0, 1, 1, 2, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3],  // row 4  ~23°S  ★PLT-01/02
  [0, 1, 1, 2, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3],  // row 5  ~24°S Santos
  [1, 1, 2, 4, 4, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],  // row 6  ~25°S
  [1, 2, 2, 4, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],  // row 7  ~26°S SP/Paraná
  [1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],  // row 8  ~27°S
  [1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3],  // row 9  ~30°S Sul
];

// ─── Colors — solid (sem imagem de fundo) ────────────────────────────────────
const T_COLOR_SOLID = {
  [T_LAND]:    '#c9a45e',
  [T_SHALLOW]: '#3db8d4',
  [T_SHELF]:   '#1b6e9e',
  [T_DEEP]:    '#0c3d6c',
  [T_OIL]:     '#c07418',
};

// ─── Colors — overlay sobre imagem do mapa (semi-transparentes) ───────────────
const T_COLOR_OVERLAY = {
  [T_LAND]:    'rgba(190,155,70, 0.50)',
  [T_SHALLOW]: 'rgba(50,180,210, 0.35)',
  [T_SHELF]:   'rgba(20,100,160, 0.28)',
  [T_DEEP]:    'rgba(8,  50,100, 0.14)',
  [T_OIL]:     'rgba(190,110,20, 0.52)',
};

// ─── Grid border per terrain ─────────────────────────────────────────────────
const T_BORDER = {
  [T_LAND]:    'rgba(140,100,40, 0.50)',
  [T_SHALLOW]: 'rgba(80,190,220, 0.35)',
  [T_SHELF]:   'rgba(50,140,200, 0.28)',
  [T_DEEP]:    'rgba(40,100,180, 0.20)',
  [T_OIL]:     'rgba(210,140,30, 0.55)',
};

// ─── Terrain names ────────────────────────────────────────────────────────────
const T_NAME = {
  [T_LAND]:    'Área Terrestre',
  [T_SHALLOW]: 'Águas Rasas (<200m)',
  [T_SHELF]:   'Plataforma Continental',
  [T_DEEP]:    'Águas Profundas',
  [T_OIL]:     'Bacia Petrolífera ★',
};

// ─── Infrastructure markers (posições visuais no mapa) ───────────────────────
const INFRA = [
  { col: 4, row: 2, type: 'naval', label: '✛', name: 'BN Rio de Janeiro'     },
  { col: 3, row: 3, type: 'port',  label: '⚓', name: 'Porto do Rio'           },
  { col: 2, row: 4, type: 'aero',  label: '✈', name: 'BA Galeão / Santa Cruz' },
  { col: 1, row: 5, type: 'port',  label: '⚓', name: 'Porto de Santos'        },
  { col: 7, row: 2, type: 'oil',   label: '▲', name: 'PLT-05'                 },
  { col: 7, row: 3, type: 'oil',   label: '▲', name: 'PLT-04'                 },
  { col: 6, row: 3, type: 'oil',   label: '▲', name: 'PLT-03'                 },
  { col: 5, row: 4, type: 'oil',   label: '▲', name: 'PLT-02'                 },
  { col: 4, row: 5, type: 'oil',   label: '▲', name: 'PLT-01'                 },
];

// ─── Movement rules ───────────────────────────────────────────────────────────
function canEnterTerrain(unitTypeOrCategory, terrain) {
  if (unitTypeOrCategory === 'air' || unitTypeOrCategory === 'helicoptero' || unitTypeOrCategory === 'patrulha')
    return true;
  if (unitTypeOrCategory === 'land')
    return terrain === T_LAND || terrain === T_SHALLOW;
  if (unitTypeOrCategory === 'submarine' || unitTypeOrCategory === 'submarino')
    return terrain !== T_LAND && terrain !== T_SHALLOW;
  return terrain !== T_LAND; // surface
}
