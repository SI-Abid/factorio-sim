// BlockForge fluids test: pump -> pipes -> boiler -> steel forge, plus mixing
// prevention and save/load of water tiles.
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

  // Unlock the fluids tech tree up front so placement/canPlace checks (which
  // gate on entityUnlocked) don't fail for reasons unrelated to what's being tested.
  await page.evaluate(() => {
    for (const id of ['automation', 'adv-tomes', 'plumbing', 'steelworks']) G.research.done[id] = true;
  });

  // ---------- 1. Pump fills adjacent pipes with water ----------
  const pumpResult = await page.evaluate(() => {
    localStorage.clear();
    const x = 60, y = 60;
    // carve a small lake at (x-1, y) so a pump at (x, y) has water on its west side
    World.oreType[World.idx(x - 1, y)] = ORE_NONE;
    World.water[World.idx(x - 1, y)] = 1;
    for (const [tx, ty] of [[x, y], [x + 1, y], [x + 2, y]]) {
      World.water[World.idx(tx, ty)] = 0;
      World.oreType[World.idx(tx, ty)] = ORE_NONE;
    }
    G.inv['pump'] = 1; G.inv['pipe'] = 3;
    const canPump = canPlace('pump', x, y);
    const pump = placeEntity('pump', x, y, 0);
    const p1 = placeEntity('pipe', x + 1, y, 0);
    const p2 = placeEntity('pipe', x + 2, y, 0);
    if (!pump || !p1 || !p2) return { placed: false };
    for (let i = 0; i < 90; i++) simTick(1 / 30); // 3 simulated seconds
    const net = fluidNetFor(p1);
    return {
      placed: true,
      canPumpOnShore: canPump,
      pumpActive: pump.active,
      netFluid: net && net.fluid,
      netAmount: net && net.amount,
      netCap: net && net.cap,
      p2Fluid: p2.fluid,
    };
  });
  console.log('pump result:', JSON.stringify(pumpResult));
  check('pump can be placed on the shore adjacent to water', pumpResult.canPumpOnShore);
  check('pump placed & pipes placed', pumpResult.placed);
  check('pump is actively pumping', pumpResult.pumpActive);
  check('pipe network filled with water', pumpResult.netFluid === 'water' && pumpResult.netAmount > 0);
  check('fluid amount respects network capacity (2 pipes * 20)', pumpResult.netCap === 40 && pumpResult.netAmount <= 40);
  check('fluid is shared across the whole connected network', pumpResult.p2Fluid === 'water');

  // A pump cannot be placed away from any water tile (clear a dry patch first —
  // lake positions are randomized per-seed, so make this deterministic).
  const noWater = await page.evaluate(() => {
    for (let ty = 69; ty <= 71; ty++) for (let tx = 69; tx <= 71; tx++) World.water[World.idx(tx, ty)] = 0;
    G.inv['pump'] = 1;
    return canPlace('pump', 70, 70);
  });
  check('pump rejected far from water', noWater === false);

  // Nothing can be built directly on a water tile (a fresh, unoccupied tile).
  const onWater = await page.evaluate(() => {
    G.inv['pipe'] = 1;
    const wx = 90, wy = 90;
    World.water[World.idx(wx, wy)] = 1;
    World.oreType[World.idx(wx, wy)] = ORE_NONE;
    return canPlace('pipe', wx, wy);
  });
  check('building is blocked on water tiles', onWater === false);

  // ---------- 2. Boiler turns water + coal into steam ----------
  const boilerResult = await page.evaluate(() => {
    const x = 60, y = 65;
    for (let ty = y; ty < y + 3; ty++) for (let tx = x - 1; tx < x + 4; tx++) {
      World.water[World.idx(tx, ty)] = 0;
      World.oreType[World.idx(tx, ty)] = ORE_NONE;
    }
    G.inv['boiler'] = 1; G.inv['pipe'] = 2;
    const waterPipe = placeEntity('pipe', x - 1, y, 0);      // west of boiler (2x2 at x,y)
    const boiler = placeEntity('boiler', x, y, 0);
    const steamPipe = placeEntity('pipe', x + 2, y, 0);      // east of boiler
    if (!waterPipe || !boiler || !steamPipe) return { placed: false };
    waterPipe.fluid = 'water'; waterPipe.amount = 20;
    boiler.fuelBuf = 5;
    for (let i = 0; i < 300; i++) simTick(1 / 30); // 10 simulated seconds
    return {
      placed: true,
      boilerActive: boiler.active,
      waterLeft: waterPipe.amount,
      steamFluid: steamPipe.fluid,
      steamAmount: steamPipe.amount,
    };
  });
  console.log('boiler result:', JSON.stringify(boilerResult));
  check('boiler placed with water/steam pipes', boilerResult.placed);
  check('boiler consumed water', boilerResult.waterLeft < 20);
  check('boiler produced steam in the OTHER network', boilerResult.steamFluid === 'steam' && boilerResult.steamAmount > 0);

  // ---------- 3. Mixing prevention ----------
  const mixResult = await page.evaluate(() => {
    const x = 60, y = 70;
    // clear a dry strip for the pipes/pump (pump sits on dry land, one tile further
    // out is where the water tile lives, per the shore-placement rule above)
    for (let ty = y - 1; ty <= y + 1; ty++) for (let tx = x - 2; tx < x + 3; tx++) {
      World.water[World.idx(tx, ty)] = 0;
      World.oreType[World.idx(tx, ty)] = ORE_NONE;
    }
    // three connected pipes already holding steam
    G.inv['pipe'] = 3;
    const a = placeEntity('pipe', x, y, 0);
    const b = placeEntity('pipe', x + 1, y, 0);
    const c = placeEntity('pipe', x + 2, y, 0);
    a.fluid = 'steam'; a.amount = 15;
    b.fluid = 'steam'; b.amount = 15;
    c.fluid = 'steam'; c.amount = 10;
    // a pump adjacent to this same network (on the shore, water one tile further west)
    // should refuse to inject water into it
    World.water[World.idx(x - 2, y)] = 1;
    G.inv['pump'] = 1;
    const pump = placeEntity('pump', x - 1, y, 0);
    for (let i = 0; i < 60; i++) simTick(1 / 30);
    const net = fluidNetFor(a);
    return {
      placed: !!(a && b && c && pump),
      pumpActive: pump.active,
      netFluid: net && net.fluid,
      netAmount: net && net.amount,
    };
  });
  console.log('mix result:', JSON.stringify(mixResult));
  check('mixing setup placed', mixResult.placed);
  check('pump does not inject water into a steam network', mixResult.pumpActive === false);
  check('network fluid stays steam (no mixing)', mixResult.netFluid === 'steam');
  check('steam amount unchanged by the blocked pump', Math.round(mixResult.netAmount) === 40);

  // ---------- 4. Steel forge produces steel-ingot end-to-end ----------
  const forgeResult = await page.evaluate(() => {
    const x = 80, y = 80;
    for (let ty = y - 1; ty < y + 4; ty++) for (let tx = x - 1; tx < x + 4; tx++) {
      World.water[World.idx(tx, ty)] = 0;
      World.oreType[World.idx(tx, ty)] = ORE_NONE;
    }
    G.inv['steel-forge'] = 1; G.inv['pipe'] = 1;
    const steamPipe = placeEntity('pipe', x - 1, y, 0);  // west of the 3x3 forge
    const forge = placeEntity('steel-forge', x, y, 0);
    if (!steamPipe || !forge) return { placed: false };
    steamPipe.fluid = 'steam'; steamPipe.amount = 20;
    forge.input['iron-ingot'] = 2;
    forge.input['coal'] = 1;
    for (let i = 0; i < 300; i++) simTick(1 / 30); // 10 simulated seconds > 6s craft time
    return {
      placed: true,
      forgeActive: forge.active,
      steel: forge.output['steel-ingot'] || 0,
      steamLeft: steamPipe.amount,
    };
  });
  console.log('forge result:', JSON.stringify(forgeResult));
  check('steel forge placed with steam supply', forgeResult.placed);
  check('steel forge produced a steel ingot', forgeResult.steel >= 1);
  check('steel forge consumed steam while working', forgeResult.steamLeft < 20);

  // steel-gear recipe consumes the steel ingot (unlocked by 'steelworks')
  const gearResult = await page.evaluate(() => {
    G.research.done['automation'] = true;
    G.research.done['adv-tomes'] = true;
    G.research.done['plumbing'] = true;
    G.research.done['steelworks'] = true;
    G.inv['steel-ingot'] = 5;
    const ok = queueHandCraft('steel-gear');
    for (let i = 0; i < 90; i++) simTick(1 / 30);
    return { ok, steelGears: invCount('steel-gear'), unlocked: entityUnlocked('steel-forge') };
  });
  check('steel-gear recipe craftable once steelworks is researched', gearResult.ok && gearResult.steelGears >= 1);
  check('steel forge entity unlocked by steelworks tech', gearResult.unlocked);

  // ---------- 5. Save/load round trip, including water tiles ----------
  const saveloadResult = await page.evaluate(() => {
    const waterBefore = Array.from(World.water);
    const waterCountBefore = waterBefore.reduce((a, b) => a + b, 0);
    const entitiesBefore = G.entities.size;
    const s = saveGame();
    const parsed = JSON.parse(s);
    const hasWaterField = Array.isArray(parsed.water);
    loadGame(s);
    const waterCountAfter = Array.from(World.water).reduce((a, b) => a + b, 0);
    return {
      hasWaterField,
      waterCountBefore,
      waterCountAfter,
      entitiesBefore,
      entitiesAfter: G.entities.size,
      steelKept: invCount('steel-gear') >= 1,
    };
  });
  console.log('saveload result:', JSON.stringify(saveloadResult));
  check('save includes a water array', saveloadResult.hasWaterField);
  check('water tiles round-trip through save/load', saveloadResult.waterCountBefore === saveloadResult.waterCountAfter && saveloadResult.waterCountBefore > 0);
  check('entities round-trip through save/load', saveloadResult.entitiesBefore === saveloadResult.entitiesAfter);
  check('inventory (steel items) round-trip through save/load', saveloadResult.steelKept);

  // ---------- 6. Old-format save (no water array) still loads without throwing ----------
  const oldSaveResult = await page.evaluate(() => {
    const s = JSON.parse(saveGame());
    delete s.water; // simulate a pre-fluids save
    let threw = null;
    try {
      loadGame(JSON.stringify(s));
    } catch (err) {
      threw = err.message;
    }
    return { threw, waterLen: World.water ? World.water.length : 0, entities: G.entities.size };
  });
  console.log('old-save result:', JSON.stringify(oldSaveResult));
  check('loading a save with no water array does not throw', oldSaveResult.threw === null);
  check('world.water still populated (regenerated lakes) after an old-format load', oldSaveResult.waterLen > 0);
  check('entities still present after an old-format load', oldSaveResult.entities > 0);

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    check('no console or page errors', true);
  }
  await browser.close();
})();
