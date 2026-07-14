// BlockForge power.test.js: electricity feature (Coal Generator, Power Pylon, Volt Drill).
const { chromium } = require('playwright');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(500);

  const check = (name, val) => { console.log((val ? 'PASS' : 'FAIL') + ': ' + name); if (!val) process.exitCode = 1; };

  // Common setup: unlock the electricity buildables and stock the inventory.
  await page.evaluate(() => {
    localStorage.clear();
    G.research.done['electricity'] = true;
    G.inv['pylon'] = 20;
    G.inv['generator'] = 20;
    G.inv['volt-drill'] = 20;
    G.inv['coal'] = 200;
  });

  // ---------- 1. generator + pylon + volt-drill mine ore ----------
  const mineTest = await page.evaluate(() => {
    const paintOre = (x, y, w, h) => {
      for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) {
        const i = World.idx(tx, ty);
        World.oreType[i] = 1; World.oreAmount[i] = 500; // iron
      }
    };
    const pole = placeEntity('pylon', 20, 20, 0);
    const gen = placeEntity('generator', 21, 20, 0);      // within POLE_RADIUS of the pole
    paintOre(24, 20, 2, 2);
    const drill = placeEntity('volt-drill', 24, 20, 0);   // within POLE_RADIUS of the pole
    if (!pole || !gen || !drill) return { placed: false };
    gen.fuel = 1000; // plenty of stored energy, skip the fuelBuf feed step
    // Run just long enough to mine one ore (rate is 1.5/s at full power) but stop
    // well before the 3-slot output buffer fills and the drill self-stalls —
    // that would zero out demand and defeat the supply/demand assertions below.
    for (let i = 0; i < 25; i++) simTick(1 / 30);
    const info = powerNetworkInfo(pole);
    return {
      placed: true,
      genPowered: gen.powered, genActive: gen.active,
      drillPowered: drill.powered, drillActive: drill.active,
      mined: G.stats.mined, outBuf: drill.outBuf.length,
      supply: info.supply, demand: info.demand, satisfaction: info.satisfaction,
    };
  });
  console.log('mineTest:', JSON.stringify(mineTest));
  check('generator + pylon + volt-drill all placed', mineTest.placed);
  check('generator is connected and generating', mineTest.genPowered && mineTest.genActive);
  check('volt-drill is connected and mining', mineTest.drillPowered && mineTest.drillActive);
  check('volt-drill mined ore', mineTest.mined > 0 && mineTest.outBuf > 0);
  check('network fully satisfied (60kW >= 30kW demand)', mineTest.supply === 60 && mineTest.demand === 30 && mineTest.satisfaction === 1);

  // ---------- 2. drill stops with no coverage ----------
  const noCoverage = await page.evaluate(() => {
    for (let ty = 60; ty < 62; ty++) for (let tx = 60; tx < 62; tx++) {
      const i = World.idx(tx, ty);
      World.oreType[i] = 1; World.oreAmount[i] = 500;
    }
    const drill = placeEntity('volt-drill', 60, 60, 0); // no pylon anywhere nearby
    if (!drill) return { placed: false };
    for (let i = 0; i < 300; i++) simTick(1 / 30);
    return {
      placed: true,
      powered: drill.powered,
      active: drill.active,
      progress: drill.progress,
      outBuf: drill.outBuf.length, // this drill's own buffer — other tests' networks keep mining independently
    };
  });
  console.log('noCoverage:', JSON.stringify(noCoverage));
  check('isolated volt-drill placed', noCoverage.placed);
  check('isolated volt-drill reports unpowered', noCoverage.powered === false);
  check('isolated volt-drill never activates', noCoverage.active === false);
  check('isolated volt-drill makes no progress and mines nothing', noCoverage.progress === 0 && noCoverage.outBuf === 0);

  // ---------- 3. undersupply slows drills proportionally ----------
  const undersupply = await page.evaluate(() => {
    const paintOre = (x, y, w, h) => {
      for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) {
        const i = World.idx(tx, ty);
        World.oreType[i] = 1; World.oreAmount[i] = 500;
      }
    };
    // Network A: one 60kW generator feeding three 30kW volt-drills (90kW demand -> 2/3 satisfaction).
    const poleA = placeEntity('pylon', 50, 50, 0);
    const genA = placeEntity('generator', 46, 50, 0);
    genA.fuel = 1000;
    paintOre(53, 50, 2, 2); const drillA1 = placeEntity('volt-drill', 53, 50, 0);
    paintOre(53, 53, 2, 2); const drillA2 = placeEntity('volt-drill', 53, 53, 0);
    paintOre(46, 53, 2, 2); const drillA3 = placeEntity('volt-drill', 46, 53, 0);

    // Network B: far away (beyond POLE_LINK_RADIUS from network A), one generator, one drill -> fully supplied.
    const poleB = placeEntity('pylon', 100, 100, 0);
    const genB = placeEntity('generator', 96, 100, 0);
    genB.fuel = 1000;
    paintOre(103, 100, 2, 2); const drillB = placeEntity('volt-drill', 103, 100, 0);

    if (![poleA, genA, drillA1, drillA2, drillA3, poleB, genB, drillB].every(Boolean)) return { placed: false };

    const dt = 1 / 30;
    simTick(dt); // exactly one tick so progress deltas are directly comparable

    const infoA = powerNetworkInfo(poleA);
    const infoB = powerNetworkInfo(poleB);
    return {
      placed: true,
      infoA, infoB,
      progressA: [drillA1.progress, drillA2.progress, drillA3.progress],
      progressB: drillB.progress,
      activeA: [drillA1.active, drillA2.active, drillA3.active],
      activeB: drillB.active,
    };
  });
  console.log('undersupply:', JSON.stringify(undersupply));
  check('undersupply scenario placed', undersupply.placed);
  check('network A is undersupplied (60kW / 90kW)', undersupply.infoA.supply === 60 && undersupply.infoA.demand === 90);
  check('network A satisfaction ~ 2/3', Math.abs(undersupply.infoA.satisfaction - 2 / 3) < 1e-9);
  check('network B is fully satisfied (60kW / 30kW, clamped to 1)', undersupply.infoB.satisfaction === 1);
  check('all three undersupplied drills are still active (slowed, not stalled)', undersupply.activeA.every(Boolean));
  check('undersupplied drills share the same reduced progress',
    Math.abs(undersupply.progressA[0] - undersupply.progressA[1]) < 1e-12 &&
    Math.abs(undersupply.progressA[1] - undersupply.progressA[2]) < 1e-12);
  check('undersupplied progress is proportionally slower than fully-supplied progress',
    undersupply.progressA[0] < undersupply.progressB &&
    Math.abs(undersupply.progressA[0] / undersupply.progressB - 2 / 3) < 1e-9);

  // ---------- 4. save / load round trip ----------
  const saveload = await page.evaluate(() => {
    const before = {
      entityCount: G.entities.size,
      mined: G.stats.mined,
    };
    // Snapshot a few specific entities' power-related fields by id.
    let pole, gen, drill;
    for (const e of G.entities.values()) {
      if (e.type === 'pylon' && pole === undefined) pole = e;
      if (e.type === 'generator' && gen === undefined) gen = e;
      if (e.type === 'volt-drill' && drill === undefined) drill = e;
    }
    const snapshot = {
      poleId: pole.id,
      genId: gen.id, genFuel: gen.fuel, genFuelBuf: gen.fuelBuf, genActive: gen.active,
      drillId: drill.id, drillProgress: drill.progress, drillOutBuf: [...drill.outBuf], drillActive: drill.active,
    };
    const s = saveGame();
    // sanity: the raw JSON must not contain a serialized "networks" or "powerGrid" blob —
    // the grid is derived state and must never be persisted.
    const hasGridState = /powerGrid|"networks"/.test(s);
    loadGame(s);

    // Compare immediately after load, before anything mutates state further.
    const pole2 = G.entities.get(snapshot.poleId);
    const gen2 = G.entities.get(snapshot.genId);
    const drill2 = G.entities.get(snapshot.drillId);
    const after = { entityCount: G.entities.size, mined: G.stats.mined };
    const poleSurvived = !!pole2 && pole2.type === 'pylon';
    const genFieldsMatch = !!gen2 && gen2.type === 'generator' && gen2.fuelBuf === snapshot.genFuelBuf;
    const drillFieldsMatch = !!drill2 && drill2.type === 'volt-drill' &&
      drill2.outBuf.length === snapshot.drillOutBuf.length;

    // Only now advance one tick, purely to confirm the (never-persisted) power grid
    // rebuilds correctly against the reloaded entity objects.
    simTick(1 / 30);
    return {
      before, after, hasGridState, poleSurvived, genFieldsMatch, drillFieldsMatch,
      infoAfterLoad: powerNetworkInfo(pole2),
    };
  });
  console.log('saveload:', JSON.stringify(saveload));
  check('save/load preserves entity count', saveload.before.entityCount === saveload.after.entityCount);
  check('save/load preserves stats', saveload.before.mined === saveload.after.mined);
  check('save file does not persist derived power-grid state', !saveload.hasGridState);
  check('pylon survives round trip', saveload.poleSurvived);
  check('generator fields survive round trip', saveload.genFieldsMatch);
  check('volt-drill fields survive round trip', saveload.drillFieldsMatch);
  check('power grid is recomputable after load', saveload.infoAfterLoad !== null);

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('PASS: no console or page errors');
  }
  await browser.close();
})();
