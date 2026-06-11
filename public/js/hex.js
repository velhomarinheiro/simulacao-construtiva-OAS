'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// HEX GRID — MAPA "OPERAÇÃO ATLÂNTICO SUL"
// Grade calibrada para coincidir com mapa.jpeg
// Flat-top hexagons (topo reto)
// ═════════════════════════════════════════════════════════════════════════════

const GRID_W = 16; // A–P
const GRID_H = 10; // 1–10

// ─── Geometria da grade ────────────────────────────────────────────────────
const HEX_R = 67.5;
const HEX_W = HEX_R * 2;
const HEX_H = HEX_R * Math.sqrt(3);

// ─── Canvas: imagem 3446×2832 exibida a 50% ───────────────────────────────
const CVS_W = 1723;
const CVS_H = 1416;

// ─── Origem da grade sobre o mapa ──────────────────────────────────────────
// Centro do hexágono A-1 (= pixel (238,372) na imagem original ÷ 2)
const OX = 119;
const OY = 186;

// ═════════════════════════════════════════════════════════════════════════════
// CONVERSÕES
// ═════════════════════════════════════════════════════════════════════════════

function oddqToCube(col, row) {
  const x = col;
  const z = row - (col - (col & 1)) / 2;

  return {
    x,
    y: -x - z,
    z
  };
}

function cubeToOddq(x, z) {
  return {
    col: x,
    row: z + (x - (x & 1)) / 2
  };
}

const CUBE_DIRS = [
  { dx:+1, dy:-1, dz: 0 },
  { dx:+1, dy: 0, dz:-1 },
  { dx: 0, dy:+1, dz:-1 },
  { dx:-1, dy:+1, dz: 0 },
  { dx:-1, dy: 0, dz:+1 },
  { dx: 0, dy:-1, dz:+1 },
];

function hexNeighbors(col, row) {
  const c = oddqToCube(col, row);

  return CUBE_DIRS
    .map(d => cubeToOddq(c.x + d.dx, c.z + d.dz))
    .filter(({ col:nc, row:nr }) =>
      nc >= 0 &&
      nc < GRID_W &&
      nr >= 0 &&
      nr < GRID_H
    );
}

function hexDist(c1, r1, c2, r2) {
  const a = oddqToCube(c1, r1);
  const b = oddqToCube(c2, r2);

  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z)
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PIXEL ↔ HEX
// ═════════════════════════════════════════════════════════════════════════════

function hexToPixel(col, row) {
  return {
    x: HEX_R * 1.5 * col + OX,
    y: HEX_H * (row + 0.5 * (col & 1)) + OY,
  };
}

function pixelToHex(px, py) {

  const approxCol =
    Math.round((px - OX) / (HEX_R * 1.5));

  const approxRow =
    Math.round(
      (py - OY - 0.5 * (approxCol & 1) * HEX_H) / HEX_H
    );

  const base = {
    col: Math.max(0, Math.min(GRID_W - 1, approxCol)),
    row: Math.max(0, Math.min(GRID_H - 1, approxRow)),
  };

  const candidates = [
    base,
    ...hexNeighbors(base.col, base.row)
  ];

  let best = base;
  let bestD = Infinity;

  for (const cand of candidates) {

    const { x, y } = hexToPixel(cand.col, cand.row);

    const d =
      (px - x) ** 2 +
      (py - y) ** 2;

    if (d < bestD) {
      bestD = d;
      best = cand;
    }
  }

  return best;
}

// ═════════════════════════════════════════════════════════════════════════════
// RANGE
// ═════════════════════════════════════════════════════════════════════════════

function hexesInRange(col, row, range) {

  const seen = new Set([`${col},${row}`]);

  const out = [];

  let frontier = [{ col, row }];

  for (let d = 0; d < range; d++) {

    const next = [];

    for (const h of frontier) {

      for (const nb of hexNeighbors(h.col, h.row)) {

        const k = `${nb.col},${nb.row}`;

        if (!seen.has(k)) {

          seen.add(k);

          out.push(nb);

          next.push(nb);
        }
      }
    }

    frontier = next;
  }

  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// DESENHO
// ═════════════════════════════════════════════════════════════════════════════

function drawHex(ctx, cx, cy, fill, stroke, lw = 1) {

  ctx.beginPath();

  for (let i = 0; i < 6; i++) {

    const a = (Math.PI / 3) * i;

    const vx = cx + HEX_R * Math.cos(a);

    const vy = cy + HEX_R * Math.sin(a);

    if (i === 0) {
      ctx.moveTo(vx, vy);
    } else {
      ctx.lineTo(vx, vy);
    }
  }

  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }

  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}

function hexLabel(col) {
  return String.fromCharCode(65 + col);
}
