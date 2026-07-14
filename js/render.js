// BlockForge — canvas renderer: procedural pixel-art sprites, terrain, entities
'use strict';

const Renderer = {
  ready: false,
  canvas: null,
  ctx: null,
  terrain: null,     // offscreen canvas with the whole map baked at TILE px/tile
  sprites: {},       // cache: key -> canvas
  icons: {},         // item id -> 16px canvas
  iconURLs: {},      // item id -> data URL (for DOM UI)

  cam: { x: WORLD_W * TILE / 2, y: WORLD_H * TILE / 2, zoom: 2.5 },

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    this.buildTerrain();
    for (const id in ITEMS) this.icon(id); // pre-build icons
    this.ready = true;
  },

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.ctx.imageSmoothingEnabled = false;
  },

  // ---------- coordinate transforms ----------
  worldToScreen(wx, wy) {
    const z = this.cam.zoom;
    return [
      (wx * TILE - this.cam.x) * z + this.canvas.width / 2,
      (wy * TILE - this.cam.y) * z + this.canvas.height / 2,
    ];
  },
  screenToWorld(sx, sy) {
    const z = this.cam.zoom;
    return [
      ((sx - this.canvas.width / 2) / z + this.cam.x) / TILE,
      ((sy - this.canvas.height / 2) / z + this.cam.y) / TILE,
    ];
  },

  // ---------- terrain ----------
  buildTerrain() {
    this.terrain = document.createElement('canvas');
    this.terrain.width = WORLD_W * TILE;
    this.terrain.height = WORLD_H * TILE;
    const tc = this.terrain.getContext('2d');
    tc.imageSmoothingEnabled = false;
    for (let y = 0; y < WORLD_H; y++)
      for (let x = 0; x < WORLD_W; x++) this.paintTile(tc, x, y);
  },
  redrawTerrain() { this.buildTerrain(); },
  redrawTile(x, y) {
    if (!this.terrain) return;
    const tc = this.terrain.getContext('2d');
    this.paintTile(tc, x, y);
  },

  paintTile(tc, x, y) {
    const px = x * TILE, py = y * TILE;
    const ore = World.oreAt(x, y);
    // grass base with pixel noise
    const g = ['#5d9b3c', '#579237', '#63a441', '#549035'];
    tc.fillStyle = g[Math.floor(tileHash(x, y, World.seed) * g.length)];
    tc.fillRect(px, py, TILE, TILE);
    for (let i = 0; i < 10; i++) {
      const h1 = tileHash(x * 31 + i, y * 17 + i, World.seed ^ i);
      const h2 = tileHash(x * 13 + i * 7, y * 29 + i * 3, World.seed ^ (i + 99));
      tc.fillStyle = h1 > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
      tc.fillRect(px + Math.floor(h1 * 8) * 2, py + Math.floor(h2 * 8) * 2, 2, 2);
    }
    if (ore !== ORE_NONE) {
      const o = ORES[ore];
      // rocky base
      tc.fillStyle = o.rock;
      tc.fillRect(px, py, TILE, TILE);
      for (let i = 0; i < 8; i++) {
        const h1 = tileHash(x * 7 + i, y * 11 + i, World.seed ^ (i + 7));
        const h2 = tileHash(x * 3 + i * 5, y * 23 + i, World.seed ^ (i + 77));
        tc.fillStyle = h1 > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
        tc.fillRect(px + Math.floor(h1 * 8) * 2, py + Math.floor(h2 * 8) * 2, 2, 2);
      }
      // ore specks, MC-ore style: little 2x2 clusters
      tc.fillStyle = o.color;
      for (let i = 0; i < 5; i++) {
        const h1 = tileHash(x * 91 + i, y * 53 + i, World.seed ^ (i + 400));
        const h2 = tileHash(x * 57 + i, y * 71 + i, World.seed ^ (i + 500));
        const ox = 1 + Math.floor(h1 * 6) * 2, oy = 1 + Math.floor(h2 * 6) * 2;
        tc.fillRect(px + ox, py + oy, 3, 2);
        tc.fillRect(px + ox + 1, py + oy - 1, 1, 1);
      }
    }
  },

  // ---------- sprite helpers ----------
  makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    return c;
  },
  rotated(base, dir) {
    if (dir === 0) return base;
    const c = this.makeCanvas(dir % 2 ? base.height : base.width, dir % 2 ? base.width : base.height);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.translate(c.width / 2, c.height / 2);
    x.rotate(dir * Math.PI / 2);
    x.drawImage(base, -base.width / 2, -base.height / 2);
    return c;
  },

  sprite(type, dir) {
    const d = ENTITY_DEFS[type];
    const key = type + ':' + (d.rot ? dir : 0);
    if (this.sprites[key]) return this.sprites[key];
    const base = this.drawSpriteBase(type);
    const s = d.rot ? this.rotated(base, dir) : base;
    this.sprites[key] = s;
    return s;
  },

  // All sprites are drawn facing NORTH, then rotated.
  drawSpriteBase(type) {
    const d = ENTITY_DEFS[type];
    const c = this.makeCanvas(d.w * TILE, d.h * TILE);
    const x = c.getContext('2d');
    const W = c.width, H = c.height;
    const px = (a, b, w, h, col) => { x.fillStyle = col; x.fillRect(a, b, w, h); };

    switch (type) {
      case 'conveyor': case 'fast-conveyor': {
        const fast = type === 'fast-conveyor';
        px(0, 0, W, H, '#3c3c44');                    // bed
        px(0, 0, 2, H, fast ? '#8a4a20' : '#26262c'); // rails
        px(W - 2, 0, 2, H, fast ? '#8a4a20' : '#26262c');
        for (let i = 2; i < H; i += 4) px(2, i, W - 4, 1, 'rgba(255,255,255,0.06)');
        break;
      }
      case 'grabber': {
        px(0, 0, W, H, '#565b63');
        px(1, 1, W - 2, H - 2, '#6a707a');
        px(5, 5, 6, 6, '#3a3e45');                    // pivot base
        px(6, 6, 4, 4, '#23262b');
        // drop-side arrow (north)
        px(7, 0, 2, 3, '#e8c34a');
        px(5, 2, 6, 1, '#e8c34a');
        break;
      }
      case 'chest': {
        px(0, 0, W, H, '#6e4722');
        px(1, 1, W - 2, H - 2, '#8a5a2b');
        px(1, 5, W - 2, 1, '#5c3a1c');                // lid seam
        for (let i = 3; i < W - 2; i += 4) px(i, 2, 1, H - 4, 'rgba(0,0,0,0.12)');
        px(6, 4, 4, 4, '#4a4a52');                    // latch
        px(7, 5, 2, 2, '#2b2b31');
        break;
      }
      case 'drill': {
        px(0, 0, W, H, '#4e5258');
        px(1, 1, W - 2, H - 2, '#7c8087');
        px(2, 2, W - 4, 2, '#9aa0a8');
        // drill housing + bit
        px(8, 8, 16, 16, '#3e4248');
        px(10, 10, 12, 12, '#54585f');
        px(14, 14, 4, 4, '#23262b');
        // corner bolts
        for (const [bx, by] of [[2, 2], [W - 4, 2], [2, H - 4], [W - 4, H - 4]]) px(bx, by, 2, 2, '#31343a');
        // output arrow at north edge
        px(W / 2 - 1, 0, 2, 4, '#e8c34a');
        px(W / 2 - 3, 3, 6, 1, '#e8c34a');
        break;
      }
      case 'furnace': {
        // cobble-ish texture
        px(0, 0, W, H, '#6a6a6a');
        const rng = makeRng(1234);
        for (let i = 0; i < 40; i++) {
          const gx = Math.floor(rng() * (W / 2)) * 2, gy = Math.floor(rng() * (H / 2)) * 2;
          px(gx, gy, 4, 3, rng() > 0.5 ? '#7f7f7f' : '#8f8f8f');
        }
        px(0, 0, W, 1, '#4c4c4c'); px(0, H - 1, W, 1, '#4c4c4c');
        px(0, 0, 1, H, '#4c4c4c'); px(W - 1, 0, 1, H, '#4c4c4c');
        // mouth (south face)
        px(W / 2 - 6, H - 10, 12, 8, '#2b2b2b');
        px(W / 2 - 4, H - 8, 8, 6, '#141414');
        break;
      }
      case 'crafter': {
        px(0, 0, W, H, '#3f5a73');
        px(1, 1, W - 2, H - 2, '#9aa0a8');
        px(3, 3, W - 6, H - 6, '#7d838c');
        // 3x3 crafting grid motif
        const gx0 = W / 2 - 11, gy0 = H / 2 - 11;
        for (let gy = 0; gy < 3; gy++)
          for (let gx = 0; gx < 3; gx++) {
            px(gx0 + gx * 8, gy0 + gy * 8, 6, 6, '#5d636c');
            px(gx0 + gx * 8 + 1, gy0 + gy * 8 + 1, 4, 4, '#494e56');
          }
        break;
      }
      case 'study': {
        px(0, 0, W, H, '#2c2842');
        px(1, 1, W - 2, H - 2, '#3a3550');
        px(4, 4, W - 8, H - 8, '#453f61');
        // open book in the middle
        const bx = W / 2 - 8, by = H / 2 - 6;
        px(bx, by, 16, 11, '#7a4fc9');       // cover
        px(bx + 1, by + 1, 6, 9, '#e8e4d8'); // pages
        px(bx + 9, by + 1, 6, 9, '#d8d4c8');
        px(bx + 7, by + 1, 2, 9, '#4a3080'); // spine
        // rune dots
        for (const [rx, ry] of [[6, 6], [W - 8, 8], [8, H - 8], [W - 10, H - 10]]) px(rx, ry, 2, 2, '#c9b84f');
        break;
      }
      case 'generator': {
        px(0, 0, W, H, '#42342a');
        px(1, 1, W - 2, H - 2, '#5a4636');
        px(3, 3, W - 6, H - 6, '#6b5340');
        // coal firebox window (south face)
        px(W / 2 - 6, H - 11, 12, 8, '#241c16');
        px(W / 2 - 4, H - 9, 8, 5, '#c85a30');
        px(W / 2 - 4, H - 9, 8, 2, '#e88a3a');
        // chimney + power stub (north)
        px(W / 2 - 3, 1, 6, 5, '#33281f');
        px(W / 2 - 1, 0, 2, 3, '#e8c94a');
        for (const [bx, by] of [[2, 2], [W - 4, 2], [2, H - 4], [W - 4, H - 4]]) px(bx, by, 2, 2, '#241c16');
        break;
      }
      case 'pylon': {
        // slim mast with a crossbar and a glowing top node — reads at any zoom
        px(W / 2 - 1, 2, 2, H - 3, '#4a4a52');
        px(2, 4, W - 4, 2, '#5a5a63');
        px(3, 5, 1, 1, '#e8c94a'); px(W - 4, 5, 1, 1, '#e8c94a'); // insulators
        px(W / 2 - 2, H - 3, 4, 3, '#33333a'); // base
        px(W / 2 - 2, 0, 4, 3, '#e8c94a');     // glowing top node
        px(W / 2 - 1, 0, 2, 1, '#fff3b0');
        break;
      }
      case 'volt-drill': {
        px(0, 0, W, H, '#2f4a58');
        px(1, 1, W - 2, H - 2, '#4fa8d8');
        px(2, 2, W - 4, 2, '#7ac4e8');
        // drill housing + bit (same layout as the Auto-Drill, cooler palette)
        px(8, 8, 16, 16, '#264050');
        px(10, 10, 12, 12, '#3a6e86');
        px(14, 14, 4, 4, '#1c3038');
        for (const [bx, by] of [[2, 2], [W - 4, 2], [2, H - 4], [W - 4, H - 4]]) px(bx, by, 2, 2, '#1c3038');
        // power bolt badge instead of a coal slot
        px(W / 2 - 1, 5, 3, 3, '#e8c94a');
        px(W / 2 - 3, 8, 3, 3, '#e8c94a');
        px(W / 2, 11, 3, 3, '#e8c94a');
        // output arrow at north edge
        px(W / 2 - 1, 0, 2, 4, '#e8c34a');
        px(W / 2 - 3, 3, 6, 1, '#e8c34a');
        break;
      }
    }
    return c;
  },

  // ---------- item icons ----------
  icon(id) {
    if (this.icons[id]) return this.icons[id];
    const def = ITEMS[id];
    const c = this.makeCanvas(16, 16);
    const x = c.getContext('2d');
    const px = (a, b, w, h, col) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
    switch (def.kind) {
      case 'ore':
        px(4, 6, 5, 5, def.color); px(8, 4, 5, 5, def.color2);
        px(6, 9, 5, 4, def.color); px(3, 5, 3, 3, def.color2);
        px(4, 6, 1, 1, 'rgba(255,255,255,0.5)');
        break;
      case 'ingot':
        px(2, 6, 12, 6, def.color2);
        px(3, 5, 10, 5, def.color);
        px(4, 6, 8, 1, 'rgba(255,255,255,0.65)');
        break;
      case 'brick':
        px(2, 4, 12, 9, def.color2);
        px(3, 5, 5, 3, def.color); px(9, 5, 4, 3, def.color);
        px(3, 9, 4, 3, def.color); px(8, 9, 5, 3, def.color);
        break;
      case 'gear':
        px(6, 2, 4, 12, def.color); px(2, 6, 12, 4, def.color);
        px(4, 4, 8, 8, def.color);
        px(6, 6, 4, 4, def.color2);
        px(7, 7, 2, 2, '#3a3d42');
        break;
      case 'wire':
        for (let i = 0; i < 3; i++) { px(3, 3 + i * 4, 10, 2, def.color); px(3, 5 + i * 4, 2, 2, def.color2); }
        px(11, 3, 2, 12, def.color2);
        break;
      case 'circuit':
        px(2, 2, 12, 12, def.color2);
        px(3, 3, 10, 10, def.color);
        px(5, 5, 3, 3, '#c9b84f');
        px(9, 9, 3, 2, '#c9b84f');
        px(4, 10, 3, 1, '#2a5d31'); px(10, 4, 1, 3, '#2a5d31');
        break;
      case 'tome':
        px(3, 2, 10, 12, def.color2);
        px(4, 2, 9, 11, def.color);
        px(11, 3, 2, 11, '#e8e4d8');   // page edge
        px(5, 5, 6, 1, '#e8e4d8'); px(5, 7, 6, 1, '#e8e4d8');
        break;
      case 'machine': {
        const s = this.sprite(id, 0);
        x.drawImage(s, 0, 0, s.width, s.height, 1, 1, 14, 14);
        break;
      }
    }
    this.icons[id] = c;
    this.iconURLs[id] = c.toDataURL();
    return c;
  },
  iconURL(id) { this.icon(id); return this.iconURLs[id]; },

  // ---------- frame ----------
  draw(state) {
    const ctx = this.ctx, z = this.cam.zoom;
    const CW = this.canvas.width, CH = this.canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#2e5d24';
    ctx.fillRect(0, 0, CW, CH);

    // visible world rect (in world px)
    const wx0 = this.cam.x - CW / 2 / z, wy0 = this.cam.y - CH / 2 / z;
    const [sx, sy] = [(0 - wx0) * z, (0 - wy0) * z];
    ctx.drawImage(this.terrain, sx, sy, this.terrain.width * z, this.terrain.height * z);

    // entities (viewport-culled)
    const tx0 = Math.floor(wx0 / TILE) - 3, ty0 = Math.floor(wy0 / TILE) - 3;
    const tx1 = Math.ceil((wx0 + CW / z) / TILE) + 3, ty1 = Math.ceil((wy0 + CH / z) / TILE) + 3;
    const drawn = new Set();
    const belts = [], others = [], grabbers = [];
    for (const e of G.entities.values()) {
      if (e.x + ENTITY_DEFS[e.type].w < tx0 || e.x > tx1 || e.y + ENTITY_DEFS[e.type].h < ty0 || e.y > ty1) continue;
      if (drawn.has(e.id)) continue;
      drawn.add(e.id);
      if (isBelt(e)) belts.push(e);
      else if (e.type === 'grabber') grabbers.push(e);
      else others.push(e);
    }

    for (const e of belts) this.drawBelt(e);
    for (const e of others) this.drawEntity(e);
    for (const e of grabbers) this.drawGrabber(e);

    // hover highlight
    if (state.hoverEnt) {
      const e = state.hoverEnt, d = ENTITY_DEFS[e.type];
      const [hx, hy] = this.worldToScreen(e.x, e.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.strokeRect(hx, hy, d.w * TILE * z, d.h * TILE * z);
    }

    // pylon coverage preview, shown while holding a pole or any electric machine
    if (state.buildSel === 'pylon' || state.buildSel === 'generator' || state.buildSel === 'volt-drill') {
      this.drawPoleCoverage();
    }

    // build ghost
    if (state.buildSel) {
      const { type, gx, gy, dir, ok } = state.ghost;
      const d = ENTITY_DEFS[type];
      const s = this.sprite(type, d.rot ? dir : 0);
      const [gsx, gsy] = this.worldToScreen(gx, gy);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(s, gsx, gsy, d.w * TILE * z, d.h * TILE * z);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = ok ? '#40ff60' : '#ff4040';
      ctx.fillRect(gsx, gsy, d.w * TILE * z, d.h * TILE * z);
      ctx.globalAlpha = 1;
    }
  },

  // Translucent squares over every existing pylon's coverage (Chebyshev radius).
  drawPoleCoverage() {
    const ctx = this.ctx, z = this.cam.zoom;
    ctx.fillStyle = 'rgba(255, 220, 80, 0.14)';
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.45)';
    ctx.lineWidth = 1;
    for (const e of G.entities.values()) {
      if (e.type !== 'pylon') continue;
      const [sx, sy] = this.worldToScreen(e.x - POLE_RADIUS, e.y - POLE_RADIUS);
      const size = (POLE_RADIUS * 2 + 1) * TILE * z;
      ctx.fillRect(sx, sy, size, size);
      ctx.strokeRect(sx, sy, size, size);
    }
  },

  drawEntity(e) {
    const ctx = this.ctx, z = this.cam.zoom;
    const d = ENTITY_DEFS[e.type];
    const s = this.sprite(e.type, d.rot ? e.dir : 0);
    const [ex, ey] = this.worldToScreen(e.x, e.y);
    ctx.drawImage(s, ex, ey, d.w * TILE * z, d.h * TILE * z);

    // dynamic bits
    if (e.type === 'furnace' && e.active) {
      const flick = 0.5 + 0.5 * Math.sin(G.time * 12 + e.id);
      ctx.fillStyle = `rgba(255,${120 + 80 * flick | 0},30,0.9)`;
      ctx.fillRect(ex + (d.w * TILE / 2 - 4) * z, ey + (d.h * TILE - 8) * z, 8 * z, 5 * z);
    }
    if (e.type === 'drill' && e.active) {
      const cx = ex + d.w * TILE * z / 2, cy = ey + d.h * TILE * z / 2;
      const ang = G.time * 6 + e.id;
      ctx.strokeStyle = '#c9b84f';
      ctx.lineWidth = Math.max(1, z);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * 5 * z, cy + Math.sin(ang) * 5 * z);
      ctx.lineTo(cx - Math.cos(ang) * 5 * z, cy - Math.sin(ang) * 5 * z);
      ctx.stroke();
    }
    if (e.type === 'crafter' && e.recipe) {
      const ic = this.icon(RECIPE_BY_ID[e.recipe].out);
      ctx.drawImage(ic, ex + (d.w * TILE / 2 - 8) * z, ey + (d.h * TILE / 2 - 8) * z, 16 * z, 16 * z);
      if (e.active) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(ex + 3 * z, ey + (d.h * TILE - 5) * z, (d.w * TILE - 6) * z * Math.min(1, e.progress), 2 * z);
      }
    }
    if (e.type === 'study' && G.research.current) {
      const spark = Math.sin(G.time * 5 + e.id) > 0.4;
      if (spark) {
        ctx.fillStyle = '#e8e44a';
        const [rx, ry] = this.worldToScreen(e.x + 0.4 + 0.2 * Math.sin(G.time * 2), e.y + 0.4);
        ctx.fillRect(rx, ry, 2 * z, 2 * z);
      }
    }
    if (e.type === 'generator' && e.active) {
      const flick = 0.5 + 0.5 * Math.sin(G.time * 11 + e.id);
      ctx.fillStyle = `rgba(255,${140 + 70 * flick | 0},40,0.9)`;
      ctx.fillRect(ex + (d.w * TILE / 2 - 4) * z, ey + (d.h * TILE - 9) * z, 8 * z, 5 * z);
      ctx.fillStyle = `rgba(255,244,150,${(0.35 + 0.35 * flick).toFixed(2)})`;
      ctx.fillRect(ex + (d.w * TILE / 2 - 1) * z, ey + 2 * z, 2 * z, 4 * z);
    }
    if (e.type === 'volt-drill' && e.active) {
      const cx = ex + d.w * TILE * z / 2, cy = ey + d.h * TILE * z / 2;
      const ang = G.time * 6 + e.id;
      ctx.strokeStyle = '#8fe0ff';
      ctx.lineWidth = Math.max(1, z);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * 5 * z, cy + Math.sin(ang) * 5 * z);
      ctx.lineTo(cx - Math.cos(ang) * 5 * z, cy - Math.sin(ang) * 5 * z);
      ctx.stroke();
    }
    if ((e.type === 'generator' || e.type === 'volt-drill') && !e.powered) {
      this.drawUnpoweredFlicker(ex, ey, d, z, e.id);
    }
  },

  // Small flickering yellow lightning bolt over electric machines with no pylon coverage.
  drawUnpoweredFlicker(ex, ey, d, z, seed) {
    if (Math.sin(G.time * 9 + seed) <= 0.2) return; // flicker on/off
    const ctx = this.ctx;
    const cx = ex + d.w * TILE * z / 2 - 1.5 * z, cy = ey + 2 * z;
    ctx.fillStyle = '#f5e34a';
    ctx.fillRect(cx, cy, 3 * z, 3 * z);
    ctx.fillRect(cx - 2 * z, cy + 3 * z, 3 * z, 3 * z);
    ctx.fillRect(cx + 1 * z, cy + 6 * z, 3 * z, 3 * z);
    ctx.fillRect(cx - 1 * z, cy + 9 * z, 3 * z, 3 * z);
  },

  drawBelt(e) {
    const ctx = this.ctx, z = this.cam.zoom;
    const d = ENTITY_DEFS[e.type];
    const s = this.sprite(e.type, e.dir);
    const [ex, ey] = this.worldToScreen(e.x, e.y);
    ctx.drawImage(s, ex, ey, TILE * z, TILE * z);

    // animated chevron
    const t = (G.time * d.speed) % 1;
    const cx = e.x + 0.5 + DX[e.dir] * (t - 0.5);
    const cy = e.y + 0.5 + DY[e.dir] * (t - 0.5);
    const [chx, chy] = this.worldToScreen(cx, cy);
    ctx.fillStyle = e.type === 'fast-conveyor' ? '#e88a3a' : '#b8b8c2';
    ctx.save();
    ctx.translate(chx, chy);
    ctx.rotate(e.dir * Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(-3 * z, 1.5 * z); ctx.lineTo(0, -2 * z); ctx.lineTo(3 * z, 1.5 * z);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // items on belt
    for (const it of e.items) {
      const ix = e.x + 0.5 + DX[e.dir] * (it.pos - 0.5);
      const iy = e.y + 0.5 + DY[e.dir] * (it.pos - 0.5);
      const [isx, isy] = this.worldToScreen(ix, iy);
      ctx.drawImage(this.icon(it.item), isx - 5 * z, isy - 5 * z, 10 * z, 10 * z);
    }
  },

  drawGrabber(e) {
    const ctx = this.ctx, z = this.cam.zoom;
    const s = this.sprite('grabber', e.dir);
    const [ex, ey] = this.worldToScreen(e.x, e.y);
    ctx.drawImage(s, ex, ey, TILE * z, TILE * z);

    // arm: from pick side (arm=0) to drop side (arm=1)
    const reach = 0.85;
    const off = (e.arm - 0.5) * 2 * reach; // -reach .. +reach along dir
    const hx = e.x + 0.5 + DX[e.dir] * off;
    const hy = e.y + 0.5 + DY[e.dir] * off;
    const [cx0, cy0] = this.worldToScreen(e.x + 0.5, e.y + 0.5);
    const [hxs, hys] = this.worldToScreen(hx, hy);
    ctx.strokeStyle = '#d8b040';
    ctx.lineWidth = Math.max(2, 2 * z);
    ctx.beginPath(); ctx.moveTo(cx0, cy0); ctx.lineTo(hxs, hys); ctx.stroke();
    ctx.fillStyle = '#8a6a20';
    ctx.fillRect(hxs - 2 * z, hys - 2 * z, 4 * z, 4 * z);
    if (e.hold) ctx.drawImage(this.icon(e.hold), hxs - 5 * z, hys - 5 * z, 10 * z, 10 * z);
  },
};
