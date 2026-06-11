'use strict';

// ─── Type abbreviation labels ─────────────────────────────────────────────────
const TYPE_ABBR = {
  carrier:          'CV',
  amphib:           'AN',
  cruzador:         'CG',
  destroier:        'DD',
  fragata:          'FF',
  corveta:          'CO',
  patrulha_oc:      'PO',
  patrulha_c:       'PC',
  logistico:        'LG',
  tanque:           'NT',
  sub_nuclear:      'SN',
  submarino:        'SS',
  patrulha:         'MP',
  caca:             'F',
  ataque:           'A',
  aew:              'AW',
  helicoptero:      'HE',
  bateria_costeira: 'BC',
  bateria_ada:      'AD',
  fpso:             'FP',
  porto:            'PT',
  aeroporto:        'BA',
};

// Legacy UNIT_DEFS kept for any code still referencing it
const UNIT_DEFS = {
  fragata:     { name: 'Fragata',           abbr: 'FF', hp: 4, mov: 3 },
  destroier:   { name: 'Destróier',         abbr: 'DD', hp: 5, mov: 4 },
  corveta:     { name: 'Corveta',           abbr: 'CO', hp: 3, mov: 3 },
  submarino:   { name: 'Submarino',         abbr: 'SS', hp: 3, mov: 3 },
  helicoptero: { name: 'Helicóptero ASW',   abbr: 'HE', hp: 2, mov: 5 },
  patrulha:    { name: 'Patrulha Marítima', abbr: 'MP', hp: 2, mov: 7 },
};

// ─── Unit counter ─────────────────────────────────────────────────────────────
function drawUnitCounter(ctx, unit, cx, cy, selected) {
  const isBlue = unit.team === 'blue';
  const bg     = isBlue ? '#0c2d5a' : '#5a0c0c';
  const border = isBlue ? '#82b1ff' : '#ff8a80';
  const R      = HEX_R * 0.50;
  const top    = cy - R * 0.72;

  if (selected) { ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 14; }

  ctx.fillStyle   = bg;
  ctx.strokeStyle = selected ? '#ffd700' : border;
  ctx.lineWidth   = selected ? 2.5 : 1.5;
  roundRect(ctx, cx - R, top, R * 2, R * 1.44, 4);
  ctx.fill(); ctx.stroke();
  ctx.shadowBlur = 0;

  // Silhouette (upper portion of counter)
  ctx.save();
  drawPlatformSilhouette(ctx, unit.type, cx, top + R * 0.48, R * 0.72, border);
  ctx.restore();

  // Type abbreviation (lower portion of counter)
  const abbr = TYPE_ABBR[unit.type] || unit.type.slice(0, 2).toUpperCase();
  ctx.fillStyle = border;
  ctx.font = `bold ${Math.max(6, Math.floor(R * 0.27))}px Courier New`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(abbr, cx, top + R * 1.18);

  // HP bar
  const hpFrac = unit.hp / unit.maxHp;
  const bw = R * 2 - 4, bh = 3;
  const bx = cx - R + 2, by = top + R * 1.44 + 2;
  ctx.fillStyle = '#050d15';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = hpFrac > 0.6 ? '#69f0ae' : hpFrac > 0.3 ? '#ffca28' : '#ff5252';
  ctx.fillRect(bx, by, bw * hpFrac, bh);
}

// ─── Silhouette dispatcher ────────────────────────────────────────────────────
function drawPlatformSilhouette(ctx, type, cx, cy, sz, color) {
  ctx.fillStyle   = color;
  ctx.strokeStyle = color;
  switch (type) {
    // ── Surface ships ──
    case 'carrier':     drawCarrierShape(ctx, cx, cy, sz); break;
    case 'amphib':      drawAmphibShape(ctx, cx, cy, sz); break;
    case 'cruzador':    drawShipShape(ctx, cx, cy, sz, 0.62, 0.54); break;
    case 'destroier':   drawShipShape(ctx, cx, cy, sz, 0.44, 0.58); break;
    case 'fragata':     drawShipShape(ctx, cx, cy, sz, 0.48, 0.52); break;
    case 'corveta':     drawShipShape(ctx, cx, cy, sz, 0.40, 0.44); break;
    case 'patrulha_oc': drawShipShape(ctx, cx, cy, sz, 0.42, 0.46); break;
    case 'patrulha_c':  drawShipShape(ctx, cx, cy, sz, 0.30, 0.36); break;
    case 'logistico':   drawCargoShape(ctx, cx, cy, sz); break;
    case 'tanque':      drawTankerShape(ctx, cx, cy, sz); break;
    // ── Submarines ──
    case 'sub_nuclear': drawSubNuclearShape(ctx, cx, cy, sz); break;
    case 'submarino':   drawSubShape(ctx, cx, cy, sz); break;
    // ── Aircraft ──
    case 'patrulha':    drawAircraftShape(ctx, cx, cy, sz); break;
    case 'caca':        drawFighterShape(ctx, cx, cy, sz); break;
    case 'ataque':      drawAttackShape(ctx, cx, cy, sz); break;
    case 'aew':         drawAEWShape(ctx, cx, cy, sz); break;
    case 'helicoptero': drawHelicopterShape(ctx, cx, cy, sz); break;
    // ── Land ──
    case 'bateria_costeira': drawBatteryShape(ctx, cx, cy, sz); break;
    case 'bateria_ada':      drawADAShape(ctx, cx, cy, sz); break;
    // ── Infrastructure ──
    case 'fpso':       drawFPSOShape(ctx, cx, cy, sz); break;
    case 'porto':      drawPortShape(ctx, cx, cy, sz); break;
    case 'aeroporto':  drawAirportShape(ctx, cx, cy, sz); break;
    default: drawShipShape(ctx, cx, cy, sz, 0.48, 0.52); break;
  }
}

// ─── Ship shapes (top-down view, bow pointing up) ─────────────────────────────

// Generic hull: bow pointing up, hw/hh = half-width/height fractions of sz
function drawShipShape(ctx, cx, cy, sz, hw, hh) {
  const w = sz * hw, h = sz * hh;
  ctx.beginPath();
  ctx.moveTo(cx,           cy - h);
  ctx.lineTo(cx + w,       cy - h * 0.15);
  ctx.lineTo(cx + w * 0.88, cy + h);
  ctx.lineTo(cx - w * 0.88, cy + h);
  ctx.lineTo(cx - w,       cy - h * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(cx - w * 0.38, cy - h * 0.05, w * 0.76, h * 0.52);
  ctx.restore();
}

// Aircraft carrier: wide flat flight deck with starboard island
function drawCarrierShape(ctx, cx, cy, sz) {
  const w = sz * 0.84, h = sz * 0.28;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.60, cy - h);
  ctx.lineTo(cx + w,        cy - h);
  ctx.lineTo(cx + w,        cy + h);
  ctx.lineTo(cx - w * 0.60, cy + h);
  ctx.lineTo(cx - w,        cy);
  ctx.closePath();
  ctx.fill();
  // Angled deck extension (port)
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.08, cy - h);
  ctx.lineTo(cx - w * 0.55, cy - h * 2.6);
  ctx.lineTo(cx - w * 0.22, cy - h * 2.6);
  ctx.lineTo(cx + w * 0.18, cy - h);
  ctx.closePath();
  ctx.fill();
  // Island superstructure (starboard)
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  ctx.fillRect(cx + w * 0.30, cy - h, w * 0.24, h * 0.68);
  ctx.restore();
}

// Amphibious ship: wide boxy hull with flat stern/well deck
function drawAmphibShape(ctx, cx, cy, sz) {
  const w = sz * 0.56, h = sz * 0.50;
  ctx.beginPath();
  ctx.moveTo(cx,      cy - h);
  ctx.lineTo(cx + w,  cy - h * 0.45);
  ctx.lineTo(cx + w,  cy + h);
  ctx.lineTo(cx - w,  cy + h);
  ctx.lineTo(cx - w,  cy - h * 0.45);
  ctx.closePath();
  ctx.fill();
  // Well deck / stern ramp indicator
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  ctx.fillRect(cx - w * 0.52, cy + h * 0.68, w * 1.04, h * 0.24);
  ctx.restore();
}

// Cargo / logistics: boxy hull with prominent hatches
function drawCargoShape(ctx, cx, cy, sz) {
  const w = sz * 0.53, h = sz * 0.46;
  ctx.beginPath();
  ctx.moveTo(cx,           cy - h);
  ctx.lineTo(cx + w * 0.85, cy - h * 0.22);
  ctx.lineTo(cx + w * 0.85, cy + h);
  ctx.lineTo(cx - w * 0.85, cy + h);
  ctx.lineTo(cx - w * 0.85, cy - h * 0.22);
  ctx.closePath();
  ctx.fill();
  // Two cargo hatches
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(cx - w * 0.65, cy - h * 0.06, w * 0.44, h * 0.48);
  ctx.fillRect(cx + w * 0.10, cy - h * 0.06, w * 0.44, h * 0.48);
  ctx.restore();
}

// Tanker: wide oval hull with circular tank domes
function drawTankerShape(ctx, cx, cy, sz) {
  ctx.beginPath();
  ctx.ellipse(cx, cy + sz * 0.04, sz * 0.58, sz * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.ellipse(cx + i * sz * 0.26, cy + sz * 0.04, sz * 0.16, sz * 0.20, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ─── Submarine shapes ─────────────────────────────────────────────────────────

// Conventional sub: horizontal torpedo ellipse + conning tower
function drawSubShape(ctx, cx, cy, sz) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.56, sz * 0.20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.50)';
  ctx.fillRect(cx - sz * 0.08, cy - sz * 0.20 - sz * 0.12, sz * 0.16, sz * 0.14);
  ctx.restore();
}

// Nuclear sub: longer hull + larger conning tower + atom symbol
function drawSubNuclearShape(ctx, cx, cy, sz) {
  // Longer hull
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.68, sz * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // Larger conning tower
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.44)';
  ctx.fillRect(cx - sz * 0.11, cy - sz * 0.22 - sz * 0.18, sz * 0.22, sz * 0.20);
  ctx.restore();
  // Atom symbol above conning tower
  const ax = cx, ay = cy - sz * 0.52;
  const nr = sz * 0.11;
  ctx.lineWidth = Math.max(0.8, sz * 0.045);
  // Nucleus dot
  ctx.beginPath();
  ctx.arc(ax, ay, sz * 0.04, 0, Math.PI * 2);
  ctx.fill();
  // Three electron orbits
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((i * Math.PI) / 3);
    ctx.beginPath();
    ctx.ellipse(0, 0, nr * 1.8, nr * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ─── Aircraft shapes (top-down view, nose pointing up) ───────────────────────

// Large maritime patrol aircraft: wide fuselage + straight wings + tail
function drawAircraftShape(ctx, cx, cy, sz) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.10, sz * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();
  // Straight wings (4-engine look, positioned mid-fuselage)
  ctx.beginPath();
  ctx.moveTo(cx,             cy - sz * 0.04);
  ctx.lineTo(cx + sz * 0.54, cy + sz * 0.12);
  ctx.lineTo(cx + sz * 0.50, cy + sz * 0.26);
  ctx.lineTo(cx,             cy + sz * 0.12);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx,             cy - sz * 0.04);
  ctx.lineTo(cx - sz * 0.54, cy + sz * 0.12);
  ctx.lineTo(cx - sz * 0.50, cy + sz * 0.26);
  ctx.lineTo(cx,             cy + sz * 0.12);
  ctx.closePath(); ctx.fill();
  // T-tail
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.36);
  ctx.lineTo(cx + sz * 0.16, cy + sz * 0.46);
  ctx.lineTo(cx - sz * 0.16, cy + sz * 0.46);
  ctx.closePath(); ctx.fill();
}

// Fighter: delta wings, highly swept, narrow fuselage
function drawFighterShape(ctx, cx, cy, sz) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.07, sz * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // Delta wings
  ctx.beginPath();
  ctx.moveTo(cx,             cy - sz * 0.04);
  ctx.lineTo(cx + sz * 0.48, cy + sz * 0.34);
  ctx.lineTo(cx + sz * 0.28, cy + sz * 0.42);
  ctx.lineTo(cx,             cy + sz * 0.10);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx,             cy - sz * 0.04);
  ctx.lineTo(cx - sz * 0.48, cy + sz * 0.34);
  ctx.lineTo(cx - sz * 0.28, cy + sz * 0.42);
  ctx.lineTo(cx,             cy + sz * 0.10);
  ctx.closePath(); ctx.fill();
  // Small tail fin
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.30);
  ctx.lineTo(cx + sz * 0.09, cy + sz * 0.42);
  ctx.lineTo(cx - sz * 0.09, cy + sz * 0.42);
  ctx.closePath(); ctx.fill();
}

// Attack aircraft: swept wings, wider chord, heavier than fighter
function drawAttackShape(ctx, cx, cy, sz) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.10, sz * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
  // Swept wings (medium sweep ~40°)
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.02);
  ctx.lineTo(cx + sz * 0.52, cy + sz * 0.26);
  ctx.lineTo(cx + sz * 0.48, cy + sz * 0.40);
  ctx.lineTo(cx,             cy + sz * 0.20);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.02);
  ctx.lineTo(cx - sz * 0.52, cy + sz * 0.26);
  ctx.lineTo(cx - sz * 0.48, cy + sz * 0.40);
  ctx.lineTo(cx,             cy + sz * 0.20);
  ctx.closePath(); ctx.fill();
  // T-tail
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.34);
  ctx.lineTo(cx + sz * 0.17, cy + sz * 0.44);
  ctx.lineTo(cx - sz * 0.17, cy + sz * 0.44);
  ctx.closePath(); ctx.fill();
}

// AEW aircraft: distinctive rotodome disc on top of standard aircraft
function drawAEWShape(ctx, cx, cy, sz) {
  // Rotodome (most distinctive feature)
  ctx.beginPath();
  ctx.ellipse(cx, cy - sz * 0.12, sz * 0.46, sz * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  // Strut
  ctx.fillRect(cx - sz * 0.04, cy - sz * 0.01, sz * 0.08, sz * 0.15);
  // Fuselage
  ctx.beginPath();
  ctx.ellipse(cx, cy + sz * 0.14, sz * 0.09, sz * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  // Wings
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.06);
  ctx.lineTo(cx + sz * 0.48, cy + sz * 0.24);
  ctx.lineTo(cx + sz * 0.42, cy + sz * 0.34);
  ctx.lineTo(cx,             cy + sz * 0.18);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.06);
  ctx.lineTo(cx - sz * 0.48, cy + sz * 0.24);
  ctx.lineTo(cx - sz * 0.42, cy + sz * 0.34);
  ctx.lineTo(cx,             cy + sz * 0.18);
  ctx.closePath(); ctx.fill();
}

// Helicopter: rotor cross + oval fuselage + tail boom + tail rotor
function drawHelicopterShape(ctx, cx, cy, sz) {
  const blade = sz * 0.52;
  ctx.lineWidth = Math.max(1.5, sz * 0.08);
  ctx.beginPath();
  ctx.moveTo(cx - blade, cy); ctx.lineTo(cx + blade, cy);
  ctx.moveTo(cx, cy - blade); ctx.lineTo(cx, cy + blade);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(cx, cy, sz * 0.13, sz * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, sz * 0.06);
  ctx.beginPath();
  ctx.moveTo(cx, cy + sz * 0.22);
  ctx.lineTo(cx, cy + sz * 0.50);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, sz * 0.05);
  ctx.beginPath();
  ctx.moveTo(cx - sz * 0.11, cy + sz * 0.50);
  ctx.lineTo(cx + sz * 0.11, cy + sz * 0.50);
  ctx.stroke();
}

// ─── Land / battery shapes ───────────────────────────────────────────────────

// Coastal missile battery: radar dish + angled launcher
function drawBatteryShape(ctx, cx, cy, sz) {
  ctx.lineWidth = Math.max(1, sz * 0.08);
  // Radar dish
  ctx.beginPath();
  ctx.arc(cx - sz * 0.18, cy - sz * 0.08, sz * 0.28, Math.PI * 1.12, Math.PI * 1.88);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - sz * 0.18, cy - sz * 0.08);
  ctx.lineTo(cx - sz * 0.18, cy + sz * 0.20);
  ctx.stroke();
  // Missile launcher (angled tube + tip)
  ctx.save();
  ctx.translate(cx + sz * 0.26, cy + sz * 0.08);
  ctx.rotate(-Math.PI * 0.28);
  ctx.fillRect(-sz * 0.06, -sz * 0.28, sz * 0.12, sz * 0.28);
  ctx.beginPath();
  ctx.moveTo(-sz * 0.06, -sz * 0.28);
  ctx.lineTo(0,          -sz * 0.42);
  ctx.lineTo(sz * 0.06,  -sz * 0.28);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // Base platform
  ctx.fillRect(cx - sz * 0.40, cy + sz * 0.30, sz * 0.80, sz * 0.14);
}

// ADA (air defence) battery: three upward SAM launcher tubes
function drawADAShape(ctx, cx, cy, sz) {
  const lw = sz * 0.09, lh = sz * 0.36;
  const tubeTop = cy - sz * 0.10;
  [-sz * 0.22, 0, sz * 0.22].forEach(ox => {
    ctx.fillRect(cx + ox - lw / 2, tubeTop, lw, lh);
    // Missile tip
    ctx.beginPath();
    ctx.moveTo(cx + ox - lw / 2, tubeTop);
    ctx.lineTo(cx + ox,          tubeTop - sz * 0.14);
    ctx.lineTo(cx + ox + lw / 2, tubeTop);
    ctx.closePath(); ctx.fill();
  });
  // Base platform
  ctx.fillRect(cx - sz * 0.40, cy + sz * 0.28, sz * 0.80, sz * 0.12);
}

// ─── Infrastructure shapes ────────────────────────────────────────────────────

// FPSO: square platform deck with corner legs + central derrick
function drawFPSOShape(ctx, cx, cy, sz) {
  const s = sz * 0.56;
  ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.40)';
  const legS = sz * 0.12;
  const corners = [[-s / 2, -s / 2], [s / 2 - legS, -s / 2], [-s / 2, s / 2 - legS], [s / 2 - legS, s / 2 - legS]];
  corners.forEach(([lx, ly]) => ctx.fillRect(cx + lx, cy + ly, legS, legS));
  ctx.fillStyle = 'rgba(0,0,0,0.50)';
  ctx.fillRect(cx - sz * 0.08, cy - sz * 0.18, sz * 0.16, sz * 0.36);
  ctx.restore();
}

// Port: anchor symbol
function drawPortShape(ctx, cx, cy, sz) {
  const lw = Math.max(1.5, sz * 0.10);
  ctx.lineWidth = lw;
  // Ring
  ctx.beginPath();
  ctx.arc(cx, cy - sz * 0.32, sz * 0.12, 0, Math.PI * 2);
  ctx.stroke();
  // Cross bar
  ctx.beginPath();
  ctx.moveTo(cx - sz * 0.30, cy - sz * 0.18);
  ctx.lineTo(cx + sz * 0.30, cy - sz * 0.18);
  ctx.stroke();
  // Shaft
  ctx.beginPath();
  ctx.moveTo(cx, cy - sz * 0.18);
  ctx.lineTo(cx, cy + sz * 0.30);
  ctx.stroke();
  // Flukes
  ctx.beginPath();
  ctx.moveTo(cx,             cy + sz * 0.30);
  ctx.lineTo(cx - sz * 0.26, cy + sz * 0.12);
  ctx.moveTo(cx,             cy + sz * 0.30);
  ctx.lineTo(cx + sz * 0.26, cy + sz * 0.12);
  ctx.stroke();
}

// Airport / airfield: two crossing runways (plus sign)
function drawAirportShape(ctx, cx, cy, sz) {
  // Primary runway (horizontal)
  ctx.fillRect(cx - sz * 0.44, cy - sz * 0.11, sz * 0.88, sz * 0.22);
  // Secondary runway (vertical)
  ctx.fillRect(cx - sz * 0.11, cy - sz * 0.44, sz * 0.22, sz * 0.88);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
  ctx.lineTo(x, y + r);     ctx.quadraticCurveTo(x, y,         x + r, y);
  ctx.closePath();
}
