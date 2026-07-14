// BlockForge — world generation and tile helpers
'use strict';

// Seeded PRNG (mulberry32)
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap deterministic per-tile hash (for terrain texture variation)
function tileHash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const World = {
  w: WORLD_W,
  h: WORLD_H,
  oreType: null,    // Uint8Array, ORE_NONE or index into ORES
  oreAmount: null,  // Int32Array

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; },
  idx(x, y) { return y * this.w + x; },

  oreAt(x, y) {
    if (!this.inBounds(x, y)) return 0;
    return this.oreType[this.idx(x, y)];
  },
  oreAmountAt(x, y) {
    if (!this.inBounds(x, y)) return 0;
    return this.oreAmount[this.idx(x, y)];
  },

  // Remove 1 ore from tile; returns the item id mined or null.
  // Clears the tile (and asks the renderer to redraw it) when depleted.
  mineTile(x, y) {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    const t = this.oreType[i];
    if (t === ORE_NONE || this.oreAmount[i] <= 0) return null;
    this.oreAmount[i]--;
    const item = ORES[t].id;
    if (this.oreAmount[i] <= 0) {
      this.oreType[i] = ORE_NONE;
      this.oreAmount[i] = 0;
      if (typeof Renderer !== 'undefined' && Renderer.ready) Renderer.redrawTile(x, y);
    }
    return item;
  },

  generate(seed) {
    this.seed = seed;
    this.oreType = new Uint8Array(this.w * this.h);
    this.oreAmount = new Int32Array(this.w * this.h);
    const rng = makeRng(seed);

    const blob = (cx, cy, r, type, richness) => {
      const r2 = Math.ceil(r + 2);
      for (let y = Math.max(0, cy - r2); y <= Math.min(this.h - 1, cy + r2); y++) {
        for (let x = Math.max(0, cx - r2); x <= Math.min(this.w - 1, cx + r2); x++) {
          const d = Math.hypot(x - cx, y - cy);
          const wobble = (tileHash(x, y, seed ^ 0x9e37) - 0.5) * 2.5;
          if (d + wobble < r) {
            const i = this.idx(x, y);
            this.oreType[i] = type;
            this.oreAmount[i] = Math.max(40, Math.round((r - d + 1) * richness * (0.7 + rng() * 0.6)));
          }
        }
      }
    };

    // Guaranteed starter patches around world center, one per quadrant.
    const cx = this.w >> 1, cy = this.h >> 1;
    blob(cx - 12, cy - 10, 5.5, 1, 90);   // iron
    blob(cx + 12, cy - 10, 5.0, 2, 90);   // copper
    blob(cx - 12, cy + 11, 5.0, 3, 90);   // coal
    blob(cx + 12, cy + 11, 4.5, 4, 80);   // stone

    // Scattered richer patches farther out.
    for (let n = 0; n < 34; n++) {
      const type = 1 + Math.floor(rng() * 4);
      const ang = rng() * Math.PI * 2;
      const dist = 28 + rng() * (this.w * 0.42);
      const px = Math.round(cx + Math.cos(ang) * dist);
      const py = Math.round(cy + Math.sin(ang) * dist);
      if (px < 6 || py < 6 || px > this.w - 6 || py > this.h - 6) continue;
      blob(px, py, 4 + rng() * 5, type, 110 + rng() * 120);
    }
  },
};
