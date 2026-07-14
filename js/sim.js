// BlockForge — simulation: entities, belts, machines, crafting, research
'use strict';

const G = {
  seed: 0,
  time: 0,
  inv: {},               // player inventory: item -> count
  entities: new Map(),   // id -> entity
  byTile: new Map(),     // "x,y" -> entity
  nextId: 1,
  craftQueue: [],        // [{recipe, t}]
  research: { current: null, progress: 0, done: {} },
  handMine: null,        // {x, y, t} while player holds mouse on ore
  stats: { mined: 0, smelted: 0, crafted: 0, placed: {} },
  victory: false,
  victoryShown: false,
  powerGrid: null,       // last tick's { poles, poleRoot, networks } — derived, never serialized
  fluidNets: [],         // this tick's fluid networks (transient, not saved)
  fluidNetOf: null,      // Map: pipe entity id -> its network (transient, not saved)
};

function keyXY(x, y) { return x + ',' + y; }
function entityAt(x, y) { return G.byTile.get(keyXY(x, y)) || null; }
function isBelt(ent) { return ent && ENTITY_DEFS[ent.type].speed !== undefined; }

// ---------- inventory ----------
function invCount(item) { return G.inv[item] || 0; }
function invAdd(item, n) { G.inv[item] = (G.inv[item] || 0) + n; if (G.inv[item] <= 0) delete G.inv[item]; }
function canAfford(costs) {
  for (const it in costs) if (invCount(it) < costs[it]) return false;
  return true;
}
function payCosts(costs) { for (const it in costs) invAdd(it, -costs[it]); }

// ---------- tech / unlock state ----------
function techDone(id) { return !!G.research.done[id]; }
function recipeUnlocked(r) { return !r.tech || techDone(r.tech); }
function entityUnlocked(type) { const d = ENTITY_DEFS[type]; return !d.tech || techDone(d.tech); }
function mineSpeedMult() { return techDone('efficiency') ? 1.5 : 1; }
function crafterSpeedMult() { return techDone('adv-automation') ? 1.5 : 1; }

// ---------- placement ----------
// Tiles occupied by `type` placed at (x,y) with rotation `dir` (top-left anchored,
// footprint swapped for E/W rotations — see footprintWH in data.js).
function tilesOf(type, x, y, dir) {
  const [w, h] = footprintWH(type, dir || 0);
  const out = [];
  for (let ty = y; ty < y + h; ty++)
    for (let tx = x; tx < x + w; tx++) out.push([tx, ty]);
  return out;
}

function canPlace(type, x, y, dir) {
  const d = ENTITY_DEFS[type];
  if (!d || !entityUnlocked(type)) return false;
  for (const [tx, ty] of tilesOf(type, x, y, dir)) {
    if (!World.inBounds(tx, ty)) return false;
    if (entityAt(tx, ty)) return false;
    if (World.isWater(tx, ty)) return false; // water blocks all building, including the Pump itself
  }
  if (type === 'drill' || type === 'volt-drill') {
    let ore = false;
    for (const [tx, ty] of tilesOf(type, x, y, dir)) if (World.oreAt(tx, ty)) ore = true;
    if (!ore) return false;
  }
  if (type === 'pump') {
    // Pumps sit on the shore (dry land) but must touch at least one water tile.
    let adjWater = false;
    for (const [tx, ty] of tilesOf(type, x, y)) {
      for (let dd = 0; dd < 4; dd++) if (World.isWater(tx + DX[dd], ty + DY[dd])) adjWater = true;
    }
    if (!adjWater) return false;
  }
  return true;
}

function makeEntity(type, x, y, dir) {
  const e = { id: G.nextId++, type, x, y, dir: dir || 0 };
  switch (type) {
    case 'conveyor': case 'fast-conveyor':
      e.items = []; break;                       // [{item, pos 0..1, lane 0|1}]
    case 'grabber':
      e.hold = null; e.arm = 0; break;           // arm: 0 = pick side, 1 = drop side
    case 'chest':
      e.store = {}; break;
    case 'drill':
      e.fuel = 0; e.fuelBuf = 0; e.progress = 0; e.outBuf = []; e.active = false; break;
    case 'furnace':
      e.fuel = 0; e.fuelBuf = 0; e.inItem = null; e.inCount = 0;
      e.outItem = null; e.outCount = 0; e.progress = 0; e.active = false; break;
    case 'crafter':
      e.recipe = null; e.input = {}; e.output = {}; e.progress = 0; e.active = false; break;
    case 'study':
      e.packs = { tome1: 0, tome2: 0 }; e.progress = 0; break;
    case 'splitter':
      e.buf = []; e.nextOut = 0; break;          // buf: [{item, lane}] mid-transfer; nextOut: 0|1 round-robin
    case 'tunnel-belt':
      e.role = 'entrance'; e.pairId = null; e.queue = []; break; // queue (entrance only): [{item, lane, t}]
    case 'generator':
      e.fuel = 0; e.fuelBuf = 0; e.active = false; e.powered = false; break;
    case 'pylon':
      break; // purely passive; coverage is computed fresh each tick
    case 'volt-drill':
      e.progress = 0; e.outBuf = []; e.active = false; e.powered = false; break;
    case 'pump':
      e.active = false; break;
    case 'pipe':
      e.fluid = null; e.amount = 0; break;                // this segment's share of its network's reservoir
    case 'boiler':
      e.fuel = 0; e.fuelBuf = 0; e.active = false; break;
    case 'steel-forge':
      e.input = {}; e.output = {}; e.progress = 0; e.active = false; break;
  }
  return e;
}

// Place from player inventory. Returns entity or null.
function placeEntity(type, x, y, dir) {
  if (!canPlace(type, x, y, dir)) return null;
  if (invCount(type) < 1) return null;
  invAdd(type, -1);
  const e = makeEntity(type, x, y, dir);
  G.entities.set(e.id, e);
  for (const [tx, ty] of tilesOf(type, x, y, dir)) G.byTile.set(keyXY(tx, ty), e);
  G.stats.placed[type] = (G.stats.placed[type] || 0) + 1;
  if (type === 'tunnel-belt') linkTunnelBelt(e);
  return e;
}

// Search up to TUNNEL_RANGE tiles ahead and behind a freshly placed tunnel-belt for an
// unpaired one facing the same way; the found tile decides which end is entrance/exit.
function linkTunnelBelt(e) {
  for (let k = 1; k <= TUNNEL_RANGE; k++) {
    for (const dir of [e.dir, oppositeDir(e.dir)]) {
      const tx = e.x + DX[dir] * k, ty = e.y + DY[dir] * k;
      const other = entityAt(tx, ty);
      if (other && other.id !== e.id && other.type === 'tunnel-belt' &&
          other.dir === e.dir && other.pairId === null) {
        if (dir === e.dir) { e.role = 'entrance'; other.role = 'exit'; }
        else { e.role = 'exit'; other.role = 'entrance'; }
        e.pairId = other.id; other.pairId = e.id;
        return;
      }
    }
  }
}

// Remove entity, refunding it and its contents to the player.
// Note: fluids (pipe/network contents) are not inventory items and are simply lost.
function removeEntity(e) {
  G.entities.delete(e.id);
  for (const [tx, ty] of tilesOf(e.type, e.x, e.y, e.dir)) G.byTile.delete(keyXY(tx, ty));
  invAdd(e.type, 1);
  if (e.items) for (const it of e.items) invAdd(it.item, 1);
  if (e.hold) invAdd(e.hold, 1);
  if (e.store) for (const k in e.store) invAdd(k, e.store[k]);
  if (e.fuelBuf) invAdd('coal', e.fuelBuf);
  if (e.outBuf) for (const it of e.outBuf) invAdd(it, 1);
  if (e.inItem && e.inCount) invAdd(e.inItem, e.inCount);
  if (e.outItem && e.outCount) invAdd(e.outItem, e.outCount);
  if (e.input) for (const k in e.input) invAdd(k, e.input[k]);
  if (e.output) for (const k in e.output) invAdd(k, e.output[k]);
  if (e.packs) { invAdd('tome1', e.packs.tome1 || 0); invAdd('tome2', e.packs.tome2 || 0); }
  if (e.buf) for (const it of e.buf) invAdd(it.item, 1);
  if (e.queue) for (const q of e.queue) invAdd(q.item, 1);
  if (e.type === 'tunnel-belt' && e.pairId !== null) {
    const p = G.entities.get(e.pairId);
    if (p) { p.pairId = null; p.role = 'entrance'; }
  }
}

// Drill output tile (adjacent, on the facing side).
function drillOutputTile(e) {
  switch (e.dir) {
    case 0: return [e.x, e.y - 1];
    case 1: return [e.x + 2, e.y];
    case 2: return [e.x + 1, e.y + 2];
    default: return [e.x - 1, e.y + 1];
  }
}

// ---------- generic item transfer into/out of entities ----------

// Try to put `item` into entity `e` (via grabber, drill output, or hand). Returns true on success.
function insertIntoEntity(e, item) {
  switch (e.type) {
    case 'chest': {
      let total = 0; for (const k in e.store) total += e.store[k];
      if (total >= CHEST_CAP) return false;
      e.store[item] = (e.store[item] || 0) + 1;
      return true;
    }
    case 'furnace': {
      if (item === 'coal' && e.fuelBuf < 5) { e.fuelBuf++; return true; }
      const r = smeltRecipeFor(item);
      if (r && (e.inItem === null || e.inItem === item) && e.inCount < 10) {
        e.inItem = item; e.inCount++;
        return true;
      }
      return false;
    }
    case 'drill': case 'boiler': {
      if (item === 'coal' && e.fuelBuf < 5) { e.fuelBuf++; return true; }
      return false;
    }
    case 'generator': {
      if (item === 'coal' && e.fuelBuf < 5) { e.fuelBuf++; return true; }
      return false;
    }
    case 'crafter': {
      if (!e.recipe) return false;
      const r = RECIPE_BY_ID[e.recipe];
      const need = r.in[item];
      if (need === undefined) return false;
      const have = e.input[item] || 0;
      if (have >= need * 3) return false;
      e.input[item] = have + 1;
      return true;
    }
    case 'steel-forge': {
      const need = STEEL_RECIPE.in[item];
      if (need === undefined) return false;
      const have = e.input[item] || 0;
      if (have >= need * 3) return false;
      e.input[item] = have + 1;
      return true;
    }
    case 'study': {
      if ((item === 'tome1' || item === 'tome2') && (e.packs[item] || 0) < 20) {
        e.packs[item] = (e.packs[item] || 0) + 1;
        return true;
      }
      return false;
    }
    case 'tunnel-belt':
      return tunnelAccept(e, item, 1); // arm/drill drops land on the right lane, like belts
  }
  return false;
}

// Try to take one item out of entity `e` (grabber pickup). Returns item id or null.
function extractFromEntity(e) {
  switch (e.type) {
    case 'chest':
      for (const k in e.store) {
        if (e.store[k] > 0) { e.store[k]--; if (!e.store[k]) delete e.store[k]; return k; }
      }
      return null;
    case 'furnace':
      if (e.outCount > 0) { e.outCount--; const it = e.outItem; if (!e.outCount) e.outItem = null; return it; }
      return null;
    case 'drill':
      if (e.outBuf.length) return e.outBuf.shift();
      return null;
    case 'volt-drill':
      if (e.outBuf.length) return e.outBuf.shift();
      return null;
    case 'crafter': case 'steel-forge':
      for (const k in e.output) {
        if (e.output[k] > 0) { e.output[k]--; if (!e.output[k]) delete e.output[k]; return k; }
      }
      return null;
    case 'tunnel-belt': {
      const r = tunnelExtractLane(e);
      return r ? r.item : null;
    }
  }
  return null;
}

// ---------- belt helpers ----------
// Each conveyor has two lanes (0 = left, 1 = right, relative to its direction of travel),
// each spaced independently by BELT_GAP. Items stay in one flat `items` array with a
// `lane` tag so the belt API and save format don't need a second list.

// Can an item be added to belt at position `pos` on lane `lane`? (no item within BELT_GAP)
function beltHasRoomAt(belt, pos, lane) {
  lane = lane || 0;
  for (const it of belt.items) if ((it.lane || 0) === lane && Math.abs(it.pos - pos) < BELT_GAP) return false;
  return true;
}
function beltAddItem(belt, item, pos, lane) {
  lane = lane || 0;
  if (!beltHasRoomAt(belt, pos, lane)) return false;
  belt.items.push({ item, pos, lane });
  return true;
}
// Remove and return {item, lane} for the belt item closest to the tile middle (or null).
function beltTakeItemLane(belt) {
  if (!belt.items.length) return null;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < belt.items.length; i++) {
    const d = Math.abs(belt.items[i].pos - 0.55);
    if (d < bestD) { bestD = d; best = i; }
  }
  const it = belt.items.splice(best, 1)[0];
  return { item: it.item, lane: it.lane || 0 };
}
// Remove and return just the item id (lane discarded) — used by grabbers.
function beltTakeItem(belt) {
  const r = beltTakeItemLane(belt);
  return r ? r.item : null;
}

// Which lane should an item entering a belt facing `toDir`, coming from an entity
// facing `fromDir`, land on? Straight continuations keep the lane; turns/side-loads
// land on whichever lane is physically nearest the incoming direction.
function transferLane(fromDir, toDir, curLane) {
  if (toDir === fromDir) return curLane || 0;
  // The source sits opposite its own travel direction, relative to the target tile.
  // If that source-relative-to-target offset lines up with the target's right side, lane 1.
  const rx = DX[(toDir + 1) % 4], ry = DY[(toDir + 1) % 4];
  return (rx * DX[fromDir] + ry * DY[fromDir]) < 0 ? 1 : 0;
}

// ---------- per-entity updates ----------

function updateBelt(e, dt) {
  if (!e.items.length) return;
  const speed = ENTITY_DEFS[e.type].speed;
  const nx = e.x + DX[e.dir], ny = e.y + DY[e.dir];
  const next = entityAt(nx, ny);

  for (let lane = 0; lane < 2; lane++) {
    const laneItems = e.items.filter(it => (it.lane || 0) === lane);
    laneItems.sort((a, b) => b.pos - a.pos);

    for (let i = 0; i < laneItems.length; i++) {
      const it = laneItems[i];
      let target = it.pos + speed * dt;
      if (i > 0) target = Math.min(target, laneItems[i - 1].pos - BELT_GAP);
      if (i === 0 && target >= 1) {
        // front item: try to flow onto the next belt or into a tunnel-belt entrance
        if (next && next.type === 'tunnel-belt' && next.role === 'entrance' && next.dir === e.dir) {
          if (tunnelAccept(next, it.item, lane)) {
            e.items.splice(e.items.indexOf(it), 1);
            laneItems.splice(i, 1); i--;
            continue;
          }
        } else if (isBelt(next) && next.dir !== oppositeDir(e.dir)) {
          const carry = Math.min(target - 1, speed * dt);
          const outLane = transferLane(e.dir, next.dir, lane);
          if (beltHasRoomAt(next, carry, outLane)) {
            e.items.splice(e.items.indexOf(it), 1);
            next.items.push({ item: it.item, pos: carry, lane: outLane });
            laneItems.splice(i, 1); i--;
            continue;
          }
        }
        target = 1; // blocked: wait at the end of the belt
      }
      it.pos = Math.max(0, Math.min(target, i === 0 ? 1 : Math.max(0, target)));
    }
  }
}

// ---------- splitter ----------

// The two tiles the splitter occupies, in a stable channel order (0, 1).
function splitterChannels(e) { return tilesOf('splitter', e.x, e.y, e.dir); }

// Hand `item` (carrying `lane`) to whatever sits at (tx,ty), belt-aware. Returns success.
// `pos` is where it lands on a belt (0.5 = arm/drill drop into the middle, like before;
// splitters/tunnel exits use a small value so items look like they're continuing a flow).
function feedForward(tx, ty, fromDir, item, lane, pos) {
  const target = entityAt(tx, ty);
  if (!target) return false;
  if (isBelt(target)) return beltAddItem(target, item, pos === undefined ? 0.5 : pos, transferLane(fromDir, target.dir, lane));
  if (target.type === 'tunnel-belt') return tunnelAccept(target, item, lane);
  return insertIntoEntity(target, item);
}
// Pull one item (with its lane, defaulting to 1 for non-belt sources) from (tx,ty).
function pullFrom(tx, ty) {
  const src = entityAt(tx, ty);
  if (!src) return null;
  if (isBelt(src)) return beltTakeItemLane(src);
  if (src.type === 'tunnel-belt') return tunnelExtractLane(src);
  const item = extractFromEntity(src);
  return item ? { item, lane: 1 } : null;
}

function updateSplitter(e, dt) {
  const channels = splitterChannels(e);

  // 1. drain the buffer to the two output tiles, round-robin, preserving lane
  let guard = e.buf.length + 1;
  while (e.buf.length && guard-- > 0) {
    const it = e.buf[0];
    const primary = e.nextOut, secondary = 1 - e.nextOut;
    const [px, py] = channels[primary], [sx, sy] = channels[secondary];
    if (feedForward(px + DX[e.dir], py + DY[e.dir], e.dir, it.item, it.lane, 0.1)) {
      e.buf.shift(); e.nextOut = secondary;
    } else if (feedForward(sx + DX[e.dir], sy + DY[e.dir], e.dir, it.item, it.lane, 0.1)) {
      e.buf.shift(); // took the other side this time; keep nextOut as-is for fairness
    } else break; // both outputs jammed
  }

  // 2. pull fresh items from behind into the buffer
  for (const [cx, cy] of channels) {
    if (e.buf.length >= SPLITTER_BUF_CAP) break;
    const r = pullFrom(cx - DX[e.dir], cy - DY[e.dir]);
    if (r) e.buf.push(r);
  }
}

// ---------- tunnel belt ----------

function tunnelPartner(e) { return e.pairId === null ? null : G.entities.get(e.pairId) || null; }
function tunnelDistance(e) {
  const p = tunnelPartner(e);
  return p ? Math.abs(p.x - e.x) + Math.abs(p.y - e.y) : null;
}
function tunnelCapacity(e) {
  const dist = tunnelDistance(e);
  return dist === null ? 1 : Math.max(1, Math.round(dist / BELT_GAP));
}
// Entrance only: enqueue an item for underground transit. Returns success.
function tunnelAccept(e, item, lane) {
  if (e.role !== 'entrance') return false;
  if (e.queue.length >= tunnelCapacity(e)) return false;
  const dist = tunnelDistance(e);
  e.queue.push({ item, lane: lane || 0, t: dist === null ? Infinity : dist / TUNNEL_SPEED });
  return true;
}
// Exit only: take the arrived front item (if its transit timer has elapsed) from the
// paired entrance's queue. Returns {item, lane} or null.
function tunnelExtractLane(e) {
  if (e.role !== 'exit') return null;
  const entrance = tunnelPartner(e);
  if (!entrance || !entrance.queue.length) return null;
  const front = entrance.queue[0];
  if (front.t > 0) return null;
  entrance.queue.shift();
  return { item: front.item, lane: front.lane };
}

function updateTunnelBelt(e, dt) {
  if (e.role !== 'entrance' || !e.queue.length) return;
  for (const q of e.queue) if (q.t > 0) q.t = Math.max(0, q.t - dt);
  const front = e.queue[0];
  if (front.t > 0) return;
  const exit = tunnelPartner(e);
  if (!exit) return; // unpaired: item waits at the mouth until a partner shows up
  // auto-deliver onto whatever sits directly beyond the exit
  if (feedForward(exit.x + DX[exit.dir], exit.y + DY[exit.dir], exit.dir, front.item, front.lane, 0.1)) {
    e.queue.shift();
  }
  // otherwise the item stays queued, ready for tunnelExtractLane (e.g. a grabber at the exit)
}

function burnFuel(e, dt) {
  // Returns true if the machine has energy this tick.
  if (e.fuel <= 0 && e.fuelBuf > 0) { e.fuelBuf--; e.fuel += FUEL_PER_COAL; }
  if (e.fuel <= 0) return false;
  e.fuel -= BURN_RATE * dt;
  return true;
}

// Push a drill-like entity's buffered output onto whatever sits at its output tile.
// Shared by the coal Auto-Drill and the electric Volt Drill (same 2x2 output geometry).
// feedForward handles belts (right-hand lane), tunnel entrances, and machine inventories.
function ejectDrillOutput(e) {
  if (!e.outBuf.length) return;
  const [ox, oy] = drillOutputTile(e);
  if (feedForward(ox, oy, e.dir, e.outBuf[0], 1)) e.outBuf.shift();
}

function updateDrill(e, dt) {
  e.active = false;
  ejectDrillOutput(e);
  if (e.outBuf.length >= 3) return; // stalled until output drains

  // find an ore tile under the drill
  let oreTile = null;
  for (const [tx, ty] of tilesOf('drill', e.x, e.y, e.dir)) {
    if (World.oreAt(tx, ty)) { oreTile = [tx, ty]; break; }
  }
  if (!oreTile) return;

  if (!burnFuel(e, dt)) return;
  e.active = true;
  e.progress += dt * mineSpeedMult() / DRILL_OP_TIME;
  if (e.progress >= 1) {
    e.progress = 0;
    const item = World.mineTile(oreTile[0], oreTile[1]);
    if (item) { e.outBuf.push(item); G.stats.mined++; }
  }
}

// ---------- electricity ----------
//
// The power grid (which pylons form a network, and each network's supply/demand)
// is recomputed from scratch every tick — it is derived state, never stored in a
// save file. Entities only carry plain, serializable fields (fuelBuf, outBuf,
// active, powered, ...) exactly like the existing fueled machines.

// Group pylons into networks: two pylons within POLE_LINK_RADIUS (Chebyshev) join
// the same network (union-find). Returns { poles, poleRoot, networks }.
function buildPowerGrid() {
  const poles = [];
  for (const e of G.entities.values()) if (e.type === 'pylon') poles.push(e);
  const n = poles.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.abs(poles[i].x - poles[j].x), dy = Math.abs(poles[i].y - poles[j].y);
      if (Math.max(dx, dy) <= POLE_LINK_RADIUS) union(i, j);
    }
  }
  const networks = new Map();  // root -> { supply, demand, satisfaction, poleCount }
  const poleRoot = new Map();  // pylon entity id -> root
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!networks.has(r)) networks.set(r, { supply: 0, demand: 0, satisfaction: 1, poleCount: 0 });
    networks.get(r).poleCount++;
    poleRoot.set(poles[i].id, r);
  }
  return { poles, poleRoot, networks };
}

// The network (root key) covering any of `tiles`, or null if none of the grid's
// pylons reach within POLE_RADIUS of them.
function networkCovering(grid, tiles) {
  for (const [tx, ty] of tiles) {
    for (const p of grid.poles) {
      if (Math.max(Math.abs(p.x - tx), Math.abs(p.y - ty)) <= POLE_RADIUS) return grid.poleRoot.get(p.id);
    }
  }
  return null;
}

// Supply/demand/satisfaction for whichever network covers entity `e` (generator,
// pylon, or volt-drill), as of the most recently simulated tick. Returns null if
// it isn't connected to any pylon (or no tick has run yet). Read-only: does not
// touch fuel/progress, so it's safe to call as often as the UI likes.
function powerNetworkInfo(e) {
  const grid = G.powerGrid;
  if (!grid) return null;
  const root = e.type === 'pylon' ? grid.poleRoot.get(e.id) : networkCovering(grid, tilesOf(e.type, e.x, e.y));
  if (root === undefined || root === null) return null;
  return grid.networks.get(root);
}

// Runs before the regular per-type dispatch: tallies generator supply and
// volt-drill demand per network, then applies mining progress at the resulting
// satisfaction (supply / demand, clamped to 1).
function updatePowerGrid(dt) {
  const grid = buildPowerGrid();

  for (const e of G.entities.values()) {
    if (e.type !== 'generator') continue;
    e.active = false;
    const root = networkCovering(grid, tilesOf('generator', e.x, e.y));
    e.powered = root !== null;
    if (root === null) continue;
    if (!burnFuel(e, dt)) continue;
    e.active = true;
    grid.networks.get(root).supply += GEN_POWER_KW;
  }

  const pending = [];
  for (const e of G.entities.values()) {
    if (e.type !== 'volt-drill') continue;
    e.active = false;
    ejectDrillOutput(e);
    const root = networkCovering(grid, tilesOf('volt-drill', e.x, e.y));
    e.powered = root !== null;
    if (e.outBuf.length >= 3) continue; // stalled until output drains
    let oreTile = null;
    for (const [tx, ty] of tilesOf('volt-drill', e.x, e.y)) {
      if (World.oreAt(tx, ty)) { oreTile = [tx, ty]; break; }
    }
    if (!oreTile || root === null) continue;
    grid.networks.get(root).demand += VOLT_DRILL_KW;
    pending.push({ e, root, oreTile });
  }

  for (const net of grid.networks.values()) {
    net.satisfaction = net.demand > 0 ? Math.min(1, net.supply / net.demand) : 1;
  }

  for (const { e, root, oreTile } of pending) {
    const sat = grid.networks.get(root).satisfaction;
    if (sat <= 0) continue;
    e.active = true;
    e.progress += dt * sat * VOLT_DRILL_SPEED_MULT / DRILL_OP_TIME;
    if (e.progress >= 1) {
      e.progress = 0;
      const item = World.mineTile(oreTile[0], oreTile[1]);
      if (item) { e.outBuf.push(item); G.stats.mined++; }
    }
  }

  G.powerGrid = grid; // cache for UI queries (powerNetworkInfo); rebuilt fresh next tick
}

function updateFurnace(e, dt) {
  e.active = false;
  const r = e.inItem ? smeltRecipeFor(e.inItem) : null;
  if (!r) { e.progress = 0; return; }
  const need = r.in[e.inItem];
  const outOk = e.outItem === null || (e.outItem === r.out && e.outCount < 10);
  if (e.inCount < need || !outOk) { return; }
  if (!burnFuel(e, dt)) return;
  e.active = true;
  e.progress += dt / r.time;
  if (e.progress >= 1) {
    e.progress = 0;
    e.inCount -= need;
    if (e.inCount <= 0) { e.inCount = 0; e.inItem = null; }
    e.outItem = r.out;
    e.outCount += r.n;
    G.stats.smelted++;
  }
}

function updateCrafter(e, dt) {
  e.active = false;
  if (!e.recipe) return;
  const r = RECIPE_BY_ID[e.recipe];
  if (e.progress > 0) {
    e.active = true;
    e.progress += dt * crafterSpeedMult() / r.time;
    if (e.progress >= 1) {
      e.progress = 0;
      e.output[r.out] = (e.output[r.out] || 0) + r.n;
      G.stats.crafted += r.n;
    }
    return;
  }
  // try to start a craft
  if ((e.output[r.out] || 0) >= r.n * 4) return;
  for (const k in r.in) if ((e.input[k] || 0) < r.in[k]) return;
  for (const k in r.in) { e.input[k] -= r.in[k]; if (!e.input[k]) delete e.input[k]; }
  e.progress = dt / r.time; // craft begins this tick
  e.active = true;
}

function updateGrabber(e, dt) {
  const step = GRABBER_SPEED * dt;
  if (e.hold === null) {
    // swing back toward pick side, then try to pick up
    e.arm = Math.max(0, e.arm - step);
    if (e.arm === 0) {
      const px = e.x - DX[e.dir], py = e.y - DY[e.dir];
      const src = entityAt(px, py);
      if (src) {
        // beltTakeItem already prefers whichever lane has an item closest to the front
        if (isBelt(src)) e.hold = beltTakeItem(src);
        else e.hold = extractFromEntity(src);
      }
    }
  } else {
    // swing toward drop side, then try to drop
    e.arm = Math.min(1, e.arm + step);
    if (e.arm === 1) {
      const dx = e.x + DX[e.dir], dy = e.y + DY[e.dir];
      const dst = entityAt(dx, dy);
      if (dst) {
        if (isBelt(dst)) {
          if (beltAddItem(dst, e.hold, 0.5, 1)) e.hold = null; // drops land on the right lane
        } else if (insertIntoEntity(dst, e.hold)) {
          e.hold = null;
        }
      }
    }
  }
}

function updateStudy(e, dt) {
  const curId = G.research.current;
  if (!curId) return;
  const tech = TECH_BY_ID[curId];
  if (e.progress > 0) {
    e.progress += dt;
    if (e.progress >= STUDY_CYCLE) {
      e.progress = 0;
      G.research.progress++;
      if (G.research.progress >= tech.units) completeResearch(tech);
    }
    return;
  }
  // start a cycle if the table has one of each required pack
  for (const p of tech.packs) if ((e.packs[p] || 0) < 1) return;
  for (const p of tech.packs) e.packs[p]--;
  e.progress = dt;
}

function completeResearch(tech) {
  G.research.done[tech.id] = true;
  G.research.current = null;
  G.research.progress = 0;
  if (typeof UI !== 'undefined') UI.toast('Research complete: ' + tech.name);
  if (tech.id === 'omega') G.victory = true;
}

function startResearch(id) {
  const t = TECH_BY_ID[id];
  if (!t || techDone(id)) return false;
  for (const r of t.req) if (!techDone(r)) return false;
  G.research.current = id;
  G.research.progress = 0;
  return true;
}

// ---------- fluids ----------
//
// Network model: every tick, connected `pipe` entities are flood-filled into
// "networks" (plain objects, not stored on entities to avoid circular refs).
// Each network is one shared reservoir: a single fluid type (or none) and a
// total amount capped at PIPE_CAP * (number of member pipes). Pumps, boilers,
// and the Steel Forge don't join a network themselves — each tick they look
// at the networks touching their footprint (via `adjacentFluidNets`) and
// push/pull fluid directly on that network object. After all machines run,
// `redistributeNetworks` splits each network's totals back out evenly onto
// its member pipes so state persists (and saves) per-pipe, tile by tile.
// Mixing is prevented structurally: producers only ever write into a network
// whose fluid is already their own type, or which is still empty.

function computeFluidNetworks() {
  const seen = new Set();
  const nets = [];
  const netOf = new Map(); // pipe entity id -> its network
  for (const e of G.entities.values()) {
    if (e.type !== 'pipe' || seen.has(e.id)) continue;
    const members = [];
    const stack = [e];
    seen.add(e.id);
    while (stack.length) {
      const p = stack.pop();
      members.push(p);
      for (let d = 0; d < 4; d++) {
        const n = entityAt(p.x + DX[d], p.y + DY[d]);
        if (n && n.type === 'pipe' && !seen.has(n.id)) { seen.add(n.id); stack.push(n); }
      }
    }
    let fluid = null;
    for (const p of members) if (p.fluid) { fluid = p.fluid; break; }
    let total = 0;
    for (const p of members) if (p.fluid === fluid) total += (p.amount || 0);
    const cap = members.length * PIPE_CAP;
    total = Math.min(total, cap);
    const net = { fluid: total > 1e-6 ? fluid : null, amount: total, cap, members };
    nets.push(net);
    for (const p of members) netOf.set(p.id, net);
  }
  return { nets, netOf };
}

// Split each network's amount evenly back onto its member pipe tiles.
function redistributeNetworks(nets) {
  for (const net of nets) {
    if (!net.members.length) continue;
    const per = net.amount / net.members.length;
    for (const p of net.members) { p.fluid = net.fluid; p.amount = per; }
  }
}

// Distinct networks touching any tile adjacent to entity `e`'s footprint.
function adjacentFluidNets(e) {
  const netOf = G.fluidNetOf;
  if (!netOf) return [];
  const nets = new Set();
  for (const [tx, ty] of tilesOf(e.type, e.x, e.y)) {
    for (let d = 0; d < 4; d++) {
      const nb = entityAt(tx + DX[d], ty + DY[d]);
      if (nb && nb.type === 'pipe') {
        const n = netOf.get(nb.id);
        if (n) nets.add(n);
      }
    }
  }
  return [...nets];
}

// The network a given pipe entity currently belongs to (or null).
function fluidNetFor(e) {
  return (G.fluidNetOf && G.fluidNetOf.get(e.id)) || null;
}

function updatePump(e, dt) {
  e.active = false;
  const nets = adjacentFluidNets(e);
  const net = nets.find(n => n.fluid === null || n.fluid === 'water');
  if (!net) return;
  const room = net.cap - net.amount;
  if (room <= 0) return;
  const add = Math.min(PUMP_RATE * dt, room);
  if (add <= 0) return;
  net.fluid = 'water';
  net.amount += add;
  e.active = true;
}

function updateBoiler(e, dt) {
  e.active = false;
  const nets = adjacentFluidNets(e);
  const inNet = nets.find(n => n.fluid === 'water' && n.amount > 0);
  if (!inNet) return;
  const outNet = nets.find(n => n !== inNet && (n.fluid === null || n.fluid === 'steam') && n.amount < n.cap);
  if (!outNet) return;
  if (!burnFuel(e, dt)) return;
  const take = Math.min(BOILER_FLOW * dt, inNet.amount, outNet.cap - outNet.amount);
  if (take <= 0) return;
  inNet.amount -= take;
  if (inNet.amount <= 1e-6) { inNet.amount = 0; inNet.fluid = null; }
  outNet.fluid = 'steam';
  outNet.amount += take; // 1:1 water-to-steam conversion
  e.active = true;
}

function updateSteelForge(e, dt) {
  e.active = false;
  const need = STEEL_RECIPE.in;
  if ((e.output[STEEL_RECIPE.out] || 0) >= STEEL_RECIPE.n * 4) return;
  const nets = adjacentFluidNets(e);
  const net = nets.find(n => n.fluid === 'steam' && n.amount > 0);
  if (!net) return; // no steam supply: stalled
  if (e.progress <= 0) {
    for (const k in need) if ((e.input[k] || 0) < need[k]) return;
    for (const k in need) { e.input[k] -= need[k]; if (!e.input[k]) delete e.input[k]; }
    e.progress = 1e-6; // craft begins this tick
  }
  const drain = Math.min(FORGE_STEAM_RATE * dt, net.amount);
  if (drain <= 0) return;
  net.amount -= drain;
  if (net.amount <= 1e-6) { net.amount = 0; net.fluid = null; }
  e.active = true;
  e.progress += dt / STEEL_RECIPE.time;
  if (e.progress >= 1) {
    e.progress = 0;
    e.output[STEEL_RECIPE.out] = (e.output[STEEL_RECIPE.out] || 0) + STEEL_RECIPE.n;
  }
}

// ---------- player hand actions ----------

function updateHandMine(dt) {
  const hm = G.handMine;
  if (!hm) return;
  if (!World.oreAt(hm.x, hm.y)) { G.handMine = null; return; }
  hm.t += dt;
  while (hm.t >= HAND_MINE_TIME) {
    hm.t -= HAND_MINE_TIME;
    const item = World.mineTile(hm.x, hm.y);
    if (item) {
      invAdd(item, 1);
      G.stats.mined++;
      if (typeof UI !== 'undefined') UI.floatText('+1 ' + ITEMS[item].name, hm.x, hm.y);
    } else {
      G.handMine = null;
      break;
    }
  }
}

// Queue a hand craft (consumes ingredients immediately).
function queueHandCraft(recipeId) {
  const r = RECIPE_BY_ID[recipeId];
  if (!r || r.station !== 'craft' || !recipeUnlocked(r)) return false;
  if (G.craftQueue.length >= 10) return false;
  if (!canAfford(r.in)) return false;
  payCosts(r.in);
  G.craftQueue.push({ recipe: recipeId, t: r.time });
  return true;
}

function updateCraftQueue(dt) {
  if (!G.craftQueue.length) return;
  const job = G.craftQueue[0];
  job.t -= dt;
  if (job.t <= 0) {
    const r = RECIPE_BY_ID[job.recipe];
    invAdd(r.out, r.n);
    G.stats.crafted += r.n;
    G.craftQueue.shift();
  }
}

// ---------- main tick ----------

function simTick(dt) {
  G.time += dt;
  updateHandMine(dt);
  updateCraftQueue(dt);
  updatePowerGrid(dt);

  // Recompute fluid networks fresh each tick (cheap at this world scale).
  const built = computeFluidNetworks();
  G.fluidNets = built.nets;
  G.fluidNetOf = built.netOf;

  for (const e of G.entities.values()) {
    switch (e.type) {
      case 'conveyor': case 'fast-conveyor': updateBelt(e, dt); break;
      case 'drill': updateDrill(e, dt); break;
      case 'furnace': updateFurnace(e, dt); break;
      case 'crafter': updateCrafter(e, dt); break;
      case 'study': updateStudy(e, dt); break;
      case 'tunnel-belt': updateTunnelBelt(e, dt); break;
      case 'pump': updatePump(e, dt); break;
      case 'boiler': updateBoiler(e, dt); break;
      case 'steel-forge': updateSteelForge(e, dt); break;
    }
  }
  redistributeNetworks(G.fluidNets);
  // grabbers & splitters after everything else so they see settled belt state
  for (const e of G.entities.values()) {
    if (e.type === 'grabber') updateGrabber(e, dt);
    else if (e.type === 'splitter') updateSplitter(e, dt);
  }
}

// ---------- save / load ----------

function saveGame() {
  const ents = [];
  for (const e of G.entities.values()) ents.push(e);
  return JSON.stringify({
    v: 1,
    seed: G.seed,
    time: G.time,
    nextId: G.nextId,
    inv: G.inv,
    research: G.research,
    stats: G.stats,
    victoryShown: G.victoryShown,
    entities: ents,
    oreType: Array.from(World.oreType),
    oreAmount: Array.from(World.oreAmount),
    water: Array.from(World.water),
  });
}

function loadGame(json) {
  const s = JSON.parse(json);
  if (s.v !== 1) throw new Error('Unknown save version');
  G.seed = s.seed;
  World.generate(s.seed); // regenerate terrain textures, then overwrite ore/water state
  World.oreType = Uint8Array.from(s.oreType);
  World.oreAmount = Int32Array.from(s.oreAmount);
  // Older saves have no `water` array — keep the freshly generated lakes from
  // World.generate() above. Any old entities that now overlap a lake still
  // load fine (canPlace is not consulted for restored entities).
  if (s.water) World.water = Uint8Array.from(s.water);
  G.time = s.time;
  G.nextId = s.nextId;
  G.inv = s.inv || {};
  G.research = s.research || { current: null, progress: 0, done: {} };
  G.stats = s.stats || { mined: 0, smelted: 0, crafted: 0, placed: {} };
  G.victory = !!(s.research && s.research.done && s.research.done.omega);
  G.victoryShown = !!s.victoryShown;
  G.craftQueue = [];
  G.handMine = null;
  G.entities = new Map();
  G.byTile = new Map();
  for (const e of s.entities) {
    G.entities.set(e.id, e);
    for (const [tx, ty] of tilesOf(e.type, e.x, e.y, e.dir)) G.byTile.set(keyXY(tx, ty), e);
  }
  if (typeof Renderer !== 'undefined' && Renderer.ready) Renderer.redrawTerrain();
}
