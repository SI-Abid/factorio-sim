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
function tilesOf(type, x, y) {
  const d = ENTITY_DEFS[type];
  const out = [];
  for (let ty = y; ty < y + d.h; ty++)
    for (let tx = x; tx < x + d.w; tx++) out.push([tx, ty]);
  return out;
}

function canPlace(type, x, y) {
  const d = ENTITY_DEFS[type];
  if (!d || !entityUnlocked(type)) return false;
  for (const [tx, ty] of tilesOf(type, x, y)) {
    if (!World.inBounds(tx, ty)) return false;
    if (entityAt(tx, ty)) return false;
    if (World.isWater(tx, ty)) return false; // water blocks all building, including the Pump itself
  }
  if (type === 'drill') {
    let ore = false;
    for (const [tx, ty] of tilesOf(type, x, y)) if (World.oreAt(tx, ty)) ore = true;
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
      e.items = []; break;                       // [{item, pos 0..1}]
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
  if (!canPlace(type, x, y)) return null;
  if (invCount(type) < 1) return null;
  invAdd(type, -1);
  const e = makeEntity(type, x, y, dir);
  G.entities.set(e.id, e);
  for (const [tx, ty] of tilesOf(type, x, y)) G.byTile.set(keyXY(tx, ty), e);
  G.stats.placed[type] = (G.stats.placed[type] || 0) + 1;
  return e;
}

// Remove entity, refunding it and its contents to the player.
// Note: fluids (pipe/network contents) are not inventory items and are simply lost.
function removeEntity(e) {
  G.entities.delete(e.id);
  for (const [tx, ty] of tilesOf(e.type, e.x, e.y)) G.byTile.delete(keyXY(tx, ty));
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
    case 'crafter': case 'steel-forge':
      for (const k in e.output) {
        if (e.output[k] > 0) { e.output[k]--; if (!e.output[k]) delete e.output[k]; return k; }
      }
      return null;
  }
  return null;
}

// ---------- belt helpers ----------

// Can an item be added to belt at position `pos`? (no item within BELT_GAP)
function beltHasRoomAt(belt, pos) {
  for (const it of belt.items) if (Math.abs(it.pos - pos) < BELT_GAP) return false;
  return true;
}
function beltAddItem(belt, item, pos) {
  if (!beltHasRoomAt(belt, pos)) return false;
  belt.items.push({ item, pos });
  return true;
}
// Remove and return the belt item closest to the tile middle (or null).
function beltTakeItem(belt) {
  if (!belt.items.length) return null;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < belt.items.length; i++) {
    const d = Math.abs(belt.items[i].pos - 0.55);
    if (d < bestD) { bestD = d; best = i; }
  }
  return belt.items.splice(best, 1)[0].item;
}

// ---------- per-entity updates ----------

function updateBelt(e, dt) {
  if (!e.items.length) return;
  const speed = ENTITY_DEFS[e.type].speed;
  e.items.sort((a, b) => b.pos - a.pos);
  const nx = e.x + DX[e.dir], ny = e.y + DY[e.dir];
  const next = entityAt(nx, ny);

  for (let i = 0; i < e.items.length; i++) {
    const it = e.items[i];
    let target = it.pos + speed * dt;
    if (i > 0) target = Math.min(target, e.items[i - 1].pos - BELT_GAP);
    if (i === 0 && target >= 1) {
      // front item: try to flow onto the next belt
      if (isBelt(next) && next.dir !== oppositeDir(e.dir)) {
        const carry = Math.min(target - 1, speed * dt);
        if (beltHasRoomAt(next, carry)) {
          e.items.shift();
          next.items.push({ item: it.item, pos: carry });
          i--;
          continue;
        }
      }
      target = 1; // blocked: wait at the end of the belt
    }
    it.pos = Math.max(0, Math.min(target, i === 0 ? 1 : Math.max(0, target)));
  }
}

function burnFuel(e, dt) {
  // Returns true if the machine has energy this tick.
  if (e.fuel <= 0 && e.fuelBuf > 0) { e.fuelBuf--; e.fuel += FUEL_PER_COAL; }
  if (e.fuel <= 0) return false;
  e.fuel -= BURN_RATE * dt;
  return true;
}

function updateDrill(e, dt) {
  e.active = false;
  // eject buffered output first
  if (e.outBuf.length) {
    const [ox, oy] = drillOutputTile(e);
    const target = entityAt(ox, oy);
    if (target) {
      if (isBelt(target)) {
        if (beltAddItem(target, e.outBuf[0], 0.5)) e.outBuf.shift();
      } else if (insertIntoEntity(target, e.outBuf[0])) {
        e.outBuf.shift();
      }
    }
  }
  if (e.outBuf.length >= 3) return; // stalled until output drains

  // find an ore tile under the drill
  let oreTile = null;
  for (const [tx, ty] of tilesOf('drill', e.x, e.y)) {
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
          if (beltAddItem(dst, e.hold, 0.5)) e.hold = null;
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
      case 'pump': updatePump(e, dt); break;
      case 'boiler': updateBoiler(e, dt); break;
      case 'steel-forge': updateSteelForge(e, dt); break;
    }
  }
  redistributeNetworks(G.fluidNets);
  // grabbers after everything else so they see settled belt state
  for (const e of G.entities.values()) {
    if (e.type === 'grabber') updateGrabber(e, dt);
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
    for (const [tx, ty] of tilesOf(e.type, e.x, e.y)) G.byTile.set(keyXY(tx, ty), e);
  }
  if (typeof Renderer !== 'undefined' && Renderer.ready) Renderer.redrawTerrain();
}
