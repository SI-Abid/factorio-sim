// BlockForge trains test: rail graph pathing, an end-to-end fueled haul between two
// depots, a broken-path waiting status, and a save/load round-trip mid-journey.
const { chromium } = require('playwright');
const path = require('path');

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(500);

  const check = (name, val) => { console.log((val ? 'PASS' : 'FAIL') + ': ' + name); if (!val) process.exitCode = 1; };

  // ---------- 1. rail graph pathing ----------
  const pathing = await page.evaluate(() => {
    localStorage.clear();
    G.research.done['railways'] = true;
    G.inv['rail'] = 100;
    // a straight line of rails from (10,10) to (18,10)
    const rails = [];
    for (let x = 10; x <= 18; x++) rails.push(placeEntity('rail', x, 10, 0));
    const okAllPlaced = rails.every(r => !!r);
    const p1 = railPath(10, 10, 18, 10);
    const straightLen = p1 ? p1.length : -1;
    const straightOrdered = p1 ? p1.every((t, i) => t.x === 10 + i && t.y === 10) : false;

    // an L-shaped branch: (14,10) down to (14,14)
    for (let y = 11; y <= 14; y++) placeEntity('rail', 14, y, 0);
    const p2 = railPath(10, 10, 14, 14);
    const lShapeOk = !!p2 && p2[p2.length - 1].x === 14 && p2[p2.length - 1].y === 14;

    // unreachable: an isolated rail with a gap
    placeEntity('rail', 30, 30, 0);
    const p3 = railPath(10, 10, 30, 30);

    // same-tile trivial path
    const p4 = railPath(10, 10, 10, 10);

    return {
      okAllPlaced, straightLen, straightOrdered, lShapeOk,
      unreachableIsNull: p3 === null,
      trivialPath: p4 && p4.length === 1 && p4[0].x === 10 && p4[0].y === 10,
    };
  });
  console.log('pathing:', JSON.stringify(pathing));
  check('rails placed for graph test', pathing.okAllPlaced);
  check('BFS finds the straight path (9 tiles)', pathing.straightLen === 9);
  check('straight path is in tile order', pathing.straightOrdered);
  check('BFS finds a path through an L-shaped branch', pathing.lShapeOk);
  check('BFS returns null for an unreachable rail', pathing.unreachableIsNull);
  check('BFS handles the trivial same-tile path', pathing.trivialPath);

  // ---------- 2. end-to-end fueled haul between two depots ----------
  const haul = await page.evaluate(() => {
    localStorage.clear();
    G.research.done['railways'] = true;
    G.entities = new Map(); G.byTile = new Map(); G.trains = []; G.depotCounter = 0;
    G.inv = { 'rail': 50, 'rail-depot': 2, 'train': 1, 'coal': 20 };

    // track: (0,20) .. (10,20); depot A sits south of (0,20), depot B sits south of (10,20)
    for (let x = 0; x <= 10; x++) placeEntity('rail', x, 20, 0);
    const depotA = placeEntity('rail-depot', 0, 21, 0);  // dir 0 (north) faces the rail at (0,20)
    const depotB = placeEntity('rail-depot', 10, 21, 0); // faces the rail at (10,20)
    if (!depotA || !depotB) return { setupOk: false };

    depotA.store['iron-ingot'] = 50;
    const train = placeEntity('train', 0, 20, 0);
    if (!train) return { setupOk: false, trainPlaced: false };
    train.depotA = depotA.id;
    train.depotB = depotB.id;
    train.loadAtA = true; // load at A, unload at B
    train.fuelBuf = 5;

    const phases = new Set();
    for (let i = 0; i < 30 * 60 && (depotB.store['iron-ingot'] || 0) < 50; i++) {
      simTick(1 / 30);
      phases.add(train.phase);
    }

    return {
      setupOk: true,
      trainPlaced: true,
      depotAIron: depotA.store['iron-ingot'] || 0,
      depotBIron: depotB.store['iron-ingot'] || 0,
      trainCargoIron: train.cargo['iron-ingot'] || 0,
      sawMoving: phases.has('moving'),
      sawDwell: phases.has('dwell'),
      fuelBurned: train.fuel < 5 * FUEL_PER_COAL || train.fuelBuf < 5,
      finalPhase: train.phase,
    };
  });
  console.log('haul:', JSON.stringify(haul));
  check('haul setup placed all entities', haul.setupOk && haul.trainPlaced);
  check('train hauled all 50 iron ingots from A to B', haul.depotBIron === 50);
  check('depot A is empty after the haul', haul.depotAIron === 0);
  check('train cargo is empty after unloading', haul.trainCargoIron === 0);
  check('train actually moved (phase saw "moving")', haul.sawMoving);
  check('train dwelled to load/unload (phase saw "dwell")', haul.sawDwell);
  check('train burned fuel while hauling', haul.fuelBurned);

  // ---------- 3. path-broken waiting status ----------
  const broken = await page.evaluate(() => {
    localStorage.clear();
    G.research.done['railways'] = true;
    G.entities = new Map(); G.byTile = new Map(); G.trains = []; G.depotCounter = 0;
    G.inv = { 'rail': 50, 'rail-depot': 2, 'train': 1, 'coal': 20 };

    for (let x = 0; x <= 6; x++) placeEntity('rail', x, 5, 0);
    const depotA = placeEntity('rail-depot', 0, 6, 0);
    const depotB = placeEntity('rail-depot', 6, 6, 0);
    const train = placeEntity('train', 0, 5, 0);
    train.depotA = depotA.id; train.depotB = depotB.id; train.loadAtA = true;
    train.fuelBuf = 5;
    depotA.store['gear'] = 10;

    // the train starts right on depot A's rail tile, so it first dwells there
    // (~4s = 120 ticks) loading cargo before it ever starts moving toward B.
    // Run just past that dwell so it's freshly under way, then rip out a rail
    // in the middle of the track, ahead of the train.
    for (let i = 0; i < 125; i++) simTick(1 / 30);
    const midRail = entityAt(3, 5);
    removeEntity(midRail);
    for (let i = 0; i < 90; i++) simTick(1 / 30);
    const blockedPhase = train.phase;
    const stuckX = train.x, stuckY = train.y;

    // repair the track and confirm it resumes
    placeEntity('rail', 3, 5, 0);
    for (let i = 0; i < 90 && (depotB.store['gear'] || 0) === 0; i++) simTick(1 / 30);

    return {
      blockedPhase,
      stuckAtX: stuckX <= 3,
      resumedAfterRepair: (depotB.store['gear'] || 0) > 0,
    };
  });
  console.log('broken path:', JSON.stringify(broken));
  check('train reports "blocked" when its path is severed', broken.blockedPhase === 'blocked');
  check('train stayed put on its side of the break', broken.stuckAtX);
  check('train resumes hauling once the track is repaired', broken.resumedAfterRepair);

  // ---------- 4. save/load round trip mid-journey ----------
  const roundtrip = await page.evaluate(() => {
    localStorage.clear();
    G.research.done['railways'] = true;
    G.entities = new Map(); G.byTile = new Map(); G.trains = []; G.depotCounter = 0;
    G.inv = { 'rail': 50, 'rail-depot': 2, 'train': 1, 'coal': 20 };

    for (let x = 0; x <= 12; x++) placeEntity('rail', x, 8, 0);
    const depotA = placeEntity('rail-depot', 0, 9, 0);
    const depotB = placeEntity('rail-depot', 12, 9, 0);
    depotA.store['circuit'] = 30;
    const train = placeEntity('train', 0, 8, 0);
    train.depotA = depotA.id; train.depotB = depotB.id; train.loadAtA = true;
    train.fuelBuf = 5;

    // run past the initial ~4s load-dwell and partway across the 12-tile
    // span so the train is truly mid-journey: moving, with fractional
    // segment progress and cargo aboard.
    for (let i = 0; i < 165; i++) simTick(1 / 30);
    const before = {
      trainCount: G.trains.length,
      x: train.x, y: train.y, segT: train.segT, phase: train.phase,
      cargo: JSON.stringify(train.cargo),
      depotAId: train.depotA, depotBId: train.depotB, loadAtA: train.loadAtA,
      fuel: train.fuel, fuelBuf: train.fuelBuf,
    };

    const saved = saveGame();
    loadGame(saved);

    const tr2 = G.trains[0];
    const after = {
      trainCount: G.trains.length,
      x: tr2.x, y: tr2.y, segT: tr2.segT, phase: tr2.phase,
      cargo: JSON.stringify(tr2.cargo),
      depotAId: tr2.depotA, depotBId: tr2.depotB, loadAtA: tr2.loadAtA,
      fuel: tr2.fuel, fuelBuf: tr2.fuelBuf,
    };

    // keep simulating post-load to make sure it still functions (path recomputed)
    const depotB2 = G.entities.get(tr2.depotB);
    for (let i = 0; i < 30 * 60 && (depotB2.store['circuit'] || 0) < 30; i++) simTick(1 / 30);

    return { before, after, deliveredAfterLoad: depotB2.store['circuit'] || 0 };
  });
  console.log('roundtrip:', JSON.stringify(roundtrip));
  check('the pre-save snapshot really is mid-journey (moving, en route)', roundtrip.before.phase === 'moving' && roundtrip.before.x > 0 && roundtrip.before.x < 12);
  check('save/load preserves the train list', roundtrip.after.trainCount === roundtrip.before.trainCount && roundtrip.after.trainCount === 1);
  check('save/load preserves train position', roundtrip.after.x === roundtrip.before.x && roundtrip.after.y === roundtrip.before.y);
  check('save/load preserves train cargo', roundtrip.after.cargo === roundtrip.before.cargo);
  check('save/load preserves train route config', roundtrip.after.depotAId === roundtrip.before.depotAId &&
    roundtrip.after.depotBId === roundtrip.before.depotBId && roundtrip.after.loadAtA === roundtrip.before.loadAtA);
  check('save/load preserves fuel state', roundtrip.after.fuel === roundtrip.before.fuel && roundtrip.after.fuelBuf === roundtrip.before.fuelBuf);
  check('train keeps hauling after a mid-journey load (path recomputed)', roundtrip.deliveredAfterLoad === 30);

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('PASS: no console or page errors');
  }
  await browser.close();
})();
