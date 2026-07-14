// BlockForge — game data definitions (items, recipes, techs, entities)
'use strict';

const TILE = 16;                 // base pixels per tile (pre-zoom)
const WORLD_W = 160;             // world size in tiles
const WORLD_H = 160;

// Directions: 0=N 1=E 2=S 3=W
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const DIR_NAMES = ['North', 'East', 'South', 'West'];
function oppositeDir(d) { return (d + 2) % 4; }

// Ore types on the map (index used in world arrays)
const ORE_NONE = 0;
const ORES = [
  null,
  { id: 'raw-iron',   name: 'Iron Ore',   color: '#d8c9b8', rock: '#8a8d92' },
  { id: 'raw-copper', name: 'Copper Ore', color: '#e0854f', rock: '#8a8d92' },
  { id: 'coal',       name: 'Coal',       color: '#2e2e33', rock: '#8a8d92' },
  { id: 'stone',      name: 'Stone',      color: '#a8a8a8', rock: '#7d7d7d' },
];

// Items. `kind` picks the procedural pixel-art icon style.
const ITEMS = {
  'raw-iron':      { name: 'Raw Iron',       kind: 'ore',     color: '#d8c9b8', color2: '#b5a58f' },
  'raw-copper':    { name: 'Raw Copper',     kind: 'ore',     color: '#e0854f', color2: '#b56436' },
  'coal':          { name: 'Coal',           kind: 'ore',     color: '#34343a', color2: '#1e1e22' },
  'stone':         { name: 'Stone',          kind: 'ore',     color: '#a0a0a0', color2: '#7c7c7c' },
  'iron-ingot':    { name: 'Iron Ingot',     kind: 'ingot',   color: '#e4e6ea', color2: '#a9adb4' },
  'copper-ingot':  { name: 'Copper Ingot',   kind: 'ingot',   color: '#e0854f', color2: '#a85c32' },
  'stone-brick':   { name: 'Stone Bricks',   kind: 'brick',   color: '#909090', color2: '#6c6c6c' },
  'gear':          { name: 'Iron Gear',      kind: 'gear',    color: '#b8bcc2', color2: '#82868c' },
  'wire':          { name: 'Copper Wire',    kind: 'wire',    color: '#e89a62', color2: '#b0602f' },
  'circuit':       { name: 'Circuit',        kind: 'circuit', color: '#3fae4d', color2: '#2a7d36' },
  'tome1':         { name: 'Basic Tome',     kind: 'tome',    color: '#c94f4f', color2: '#8e3434' },
  'tome2':         { name: 'Advanced Tome',  kind: 'tome',    color: '#4fc95f', color2: '#348e40' },
  'conveyor':      { name: 'Conveyor',       kind: 'machine', color: '#c8a23a' },
  'fast-conveyor': { name: 'Fast Conveyor',  kind: 'machine', color: '#d86a30' },
  'grabber':       { name: 'Grabber Arm',    kind: 'machine', color: '#d8b040' },
  'chest':         { name: 'Chest',          kind: 'machine', color: '#8a5a2b' },
  'drill':         { name: 'Auto-Drill',     kind: 'machine', color: '#7c8087' },
  'furnace':       { name: 'Furnace',        kind: 'machine', color: '#8f8f8f' },
  'crafter':       { name: 'Crafter',        kind: 'machine', color: '#5f8fb0' },
  'study':         { name: 'Study Table',    kind: 'machine', color: '#7a4fc9' },
  'bolt':          { name: 'Bolt',           kind: 'bolt',    color: '#c9c245', color2: '#8f8a2e' },
  'wall':          { name: 'Wall',           kind: 'machine', color: '#8a8a8a' },
  'turret':        { name: 'Bolt Turret',    kind: 'machine', color: '#5a6a3a' },
};

// Recipes.
// station: 'furnace' = smelting; 'craft' = hand-craftable AND crafter-able.
// tech: recipe locked until that tech is researched.
const RECIPES = [
  { id: 'iron-ingot',    out: 'iron-ingot',    n: 1, time: 2, in: { 'raw-iron': 1 },                    station: 'furnace' },
  { id: 'copper-ingot',  out: 'copper-ingot',  n: 1, time: 2, in: { 'raw-copper': 1 },                  station: 'furnace' },
  { id: 'stone-brick',   out: 'stone-brick',   n: 1, time: 2, in: { 'stone': 2 },                       station: 'furnace' },
  { id: 'gear',          out: 'gear',          n: 1, time: 1, in: { 'iron-ingot': 2 },                  station: 'craft' },
  { id: 'wire',          out: 'wire',          n: 2, time: 1, in: { 'copper-ingot': 1 },                station: 'craft' },
  { id: 'circuit',       out: 'circuit',       n: 1, time: 2, in: { 'iron-ingot': 1, 'wire': 3 },       station: 'craft' },
  { id: 'tome1',         out: 'tome1',         n: 1, time: 4, in: { 'copper-ingot': 1, 'gear': 1 },     station: 'craft' },
  { id: 'tome2',         out: 'tome2',         n: 1, time: 6, in: { 'conveyor': 1, 'grabber': 1 },      station: 'craft', tech: 'adv-tomes' },
  { id: 'conveyor',      out: 'conveyor',      n: 2, time: 1, in: { 'gear': 1, 'iron-ingot': 1 },       station: 'craft' },
  { id: 'fast-conveyor', out: 'fast-conveyor', n: 1, time: 1, in: { 'conveyor': 1, 'gear': 1, 'iron-ingot': 1 }, station: 'craft', tech: 'logistics' },
  { id: 'grabber',       out: 'grabber',       n: 1, time: 1, in: { 'circuit': 1, 'gear': 1, 'iron-ingot': 1 }, station: 'craft' },
  { id: 'chest',         out: 'chest',         n: 1, time: 1, in: { 'stone': 8 },                       station: 'craft' },
  { id: 'drill',         out: 'drill',         n: 1, time: 2, in: { 'iron-ingot': 5, 'gear': 3 },       station: 'craft' },
  { id: 'furnace',       out: 'furnace',       n: 1, time: 2, in: { 'stone': 8 },                       station: 'craft' },
  { id: 'crafter',       out: 'crafter',       n: 1, time: 4, in: { 'iron-ingot': 9, 'gear': 3, 'circuit': 3 }, station: 'craft', tech: 'automation' },
  { id: 'study',         out: 'study',         n: 1, time: 4, in: { 'stone-brick': 10, 'circuit': 5, 'gear': 5 }, station: 'craft' },
  { id: 'bolt',          out: 'bolt',          n: 4, time: 1, in: { 'iron-ingot': 1 },                  station: 'craft' },
  { id: 'wall',          out: 'wall',          n: 1, time: 2, in: { 'stone-brick': 4 },                 station: 'craft', tech: 'fortification' },
  { id: 'turret',        out: 'turret',        n: 1, time: 3, in: { 'iron-ingot': 4, 'gear': 2, 'circuit': 2 }, station: 'craft', tech: 'fortification' },
];
const RECIPE_BY_ID = {};
for (const r of RECIPES) RECIPE_BY_ID[r.id] = r;

// Find the furnace recipe whose single ingredient is `item` (or null).
function smeltRecipeFor(item) {
  for (const r of RECIPES) {
    if (r.station === 'furnace' && r.in[item] !== undefined) return r;
  }
  return null;
}

// Technologies. Each research unit consumes 1 of each pack type; `units` total.
const TECHS = [
  { id: 'automation',     name: 'Automation',        units: 15, packs: ['tome1'], req: [],
    desc: 'Unlocks the Crafter, which crafts items automatically.' },
  { id: 'logistics',      name: 'Fast Logistics',    units: 15, packs: ['tome1'], req: [],
    desc: 'Unlocks Fast Conveyors (2× belt speed).' },
  { id: 'adv-tomes',      name: 'Advanced Tomes',    units: 20, packs: ['tome1'], req: [],
    desc: 'Unlocks crafting of Advanced Tomes.' },
  { id: 'efficiency',     name: 'Efficient Drilling', units: 20, packs: ['tome1', 'tome2'], req: ['adv-tomes'],
    desc: 'Auto-Drills mine 50% faster.' },
  { id: 'adv-automation', name: 'Mass Production',   units: 20, packs: ['tome1', 'tome2'], req: ['automation', 'adv-tomes'],
    desc: 'Crafters work 50% faster.' },
  { id: 'omega',          name: 'Omega Research',    units: 40, packs: ['tome1', 'tome2'], req: ['logistics', 'efficiency', 'adv-automation'],
    desc: 'The final breakthrough. Completes the game.' },
  { id: 'fortification',  name: 'Fortification',    units: 10, packs: ['tome1'], req: [],
    desc: 'Unlocks Walls and Bolt Turrets to defend against hostile creatures.' },
];
const TECH_BY_ID = {};
for (const t of TECHS) TECH_BY_ID[t.id] = t;

// Placeable entities. `speed` (tiles/sec) marks conveyor-type entities.
// Hotbar order = order here.
const ENTITY_DEFS = {
  'conveyor':      { name: 'Conveyor',      w: 1, h: 1, rot: true,  speed: 1.5, hp: 50,
    desc: 'Moves items. Rotate with R.' },
  'grabber':       { name: 'Grabber Arm',   w: 1, h: 1, rot: true, hp: 50,
    desc: 'Picks up from the tile behind, drops to the tile in front.' },
  'drill':         { name: 'Auto-Drill',    w: 2, h: 2, rot: true, hp: 150,
    desc: 'Mines ore beneath it. Burns coal. Outputs at the arrow.' },
  'furnace':       { name: 'Furnace',       w: 2, h: 2, rot: false, hp: 150,
    desc: 'Smelts ore into ingots. Burns coal.' },
  'chest':         { name: 'Chest',         w: 1, h: 1, rot: false, cap: 300, hp: 80,
    desc: 'Stores up to 300 items.' },
  'crafter':       { name: 'Crafter',       w: 3, h: 3, rot: false, tech: 'automation', hp: 200,
    desc: 'Automatically crafts a chosen recipe.' },
  'study':         { name: 'Study Table',   w: 3, h: 3, rot: false, hp: 200,
    desc: 'Consumes tomes to research technology.' },
  'fast-conveyor': { name: 'Fast Conveyor', w: 1, h: 1, rot: true, speed: 3, tech: 'logistics', hp: 50,
    desc: 'Moves items twice as fast.' },
  'den':           { name: 'Creature Den',  w: 3, h: 3, rot: false, hp: 300,
    desc: 'A hostile creature den. Cannot be built or removed by the player.' },
  'wall':          { name: 'Wall',          w: 1, h: 1, rot: false, tech: 'fortification', hp: 300,
    desc: 'A sturdy barrier. Blocks movement; has no other function.' },
  'turret':        { name: 'Bolt Turret',   w: 1, h: 1, rot: false, tech: 'fortification', hp: 150, cap: 20,
    desc: 'Auto-fires bolts at hostile creatures within range.' },
};
// BUILDABLE = hotbar order. 'den' is worldgen-only and excluded (not player-placeable).
const BUILDABLE = Object.keys(ENTITY_DEFS).filter(t => t !== 'den');

// Belt item spacing (fraction of a tile) and misc tuning
const BELT_GAP = 0.3;
const GRABBER_SPEED = 2.5;   // arm sweeps per second (each way)
const DRILL_OP_TIME = 1.0;   // seconds per ore at 1× speed
const FUEL_PER_COAL = 8;     // energy units per coal
const BURN_RATE = 2;         // energy units per second while working
const STUDY_CYCLE = 2;       // seconds per research unit per study table
const CHEST_CAP = 300;
const HAND_MINE_TIME = 0.4;  // seconds per hand-mined ore

// ---------- pollution ----------
const POLLUTION_CELL = 8;              // tiles per pollution grid cell (coarse)
const POLLUTION_EMIT_RATE = 3;         // pollution/sec emitted by an actively-working fueled machine
const POLLUTION_DECAY_RATE = 0.03;     // fraction of a cell's pollution that decays per second
const POLLUTION_DIFFUSE_RATE = 0.15;   // fraction exchanged with neighbor cells per second
const POLLUTION_CAP = 400;             // clamp per cell

// ---------- creature dens & smoglings ----------
const DEN_COUNT = 8;
const DEN_MIN_DIST = 45;               // tiles from world center
const DEN_SPAWN_INTERVAL = 30;         // seconds between a den's spawn checks
const DEN_SPAWN_THRESHOLD = 40;        // pollution level (in the den's cell) required to spawn
const SMOGLING_HP = 30;
const SMOGLING_SPEED = 2;              // tiles/sec
const SMOGLING_DPS = 10;               // melee damage per second while in contact
const CREATURE_ATTACK_RANGE = 0.65;    // extra tiles of reach beyond a target's half-size

// ---------- defenses ----------
const TURRET_RANGE = 7;                // tiles
const TURRET_RATE = 2;                 // shots/sec
const TURRET_DAMAGE = 15;
const TURRET_AMMO_CAP = 20;
const REPAIR_COST = { 'iron-ingot': 2 };

const STARTER_KIT = {
  'drill': 2, 'furnace': 4, 'conveyor': 30, 'grabber': 6, 'chest': 4,
  'study': 1, 'coal': 60, 'iron-ingot': 30, 'gear': 10,
};
