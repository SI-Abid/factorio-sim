// BlockForge smoke test: load the game headless and drive a full production chain.
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

  const fail = (msg) => { console.error('FAIL: ' + msg); process.exitCode = 1; };
  const check = (name, val) => { console.log((val ? 'PASS' : 'FAIL') + ': ' + name); if (!val) process.exitCode = 1; };

  // 1. Game booted
  check('game booted (entities map exists)', await page.evaluate(() => typeof G === 'object' && G.entities instanceof Map));
  check('world generated with ore', await page.evaluate(() => {
    let n = 0; for (let i = 0; i < World.oreType.length; i++) if (World.oreType[i]) n++;
    return n > 500;
  }));

  // 2. Build a full chain on a synthetic ore patch:
  //    drill(E) -> conveyor -> conveyor -> grabber -> furnace -> grabber -> chest
  const result = await page.evaluate(() => {
    localStorage.clear();
    // Deterministic test terrain: worldgen dens and lakes can land on this test's
    // fixed coordinates on some seeds, so clear them before building.
    G.peaceful = true;
    for (const e of [...G.entities.values()]) if (e.type === 'den') removeEntity(e);
    if (G.creatures) G.creatures.length = 0;
    if (World.water) World.water.fill(0);
    const x = 20, y = 20;
    // paint a fresh iron patch under the drill
    for (let ty = y; ty < y + 2; ty++) for (let tx = x; tx < x + 2; tx++) {
      const i = World.idx(tx, ty);
      World.oreType[i] = 1; World.oreAmount[i] = 500;
      if (World.water) World.water[i] = 0;
    }
    G.inv['drill'] = 1; G.inv['furnace'] = 1; G.inv['conveyor'] = 5;
    G.inv['grabber'] = 5; G.inv['chest' ] = 1; G.inv['coal'] = 50;

    const drill = placeEntity('drill', x, y, 1);          // faces East, output at (x+2, y)
    const b1 = placeEntity('conveyor', x + 2, y, 1);
    const b2 = placeEntity('conveyor', x + 3, y, 1);
    const g1 = placeEntity('grabber', x + 4, y, 1);       // belt -> furnace
    const fur = placeEntity('furnace', x + 5, y - 1, 0);
    const g2 = placeEntity('grabber', x + 7, y, 1);       // furnace -> chest
    const chest = placeEntity('chest', x + 8, y, 0);
    if (!drill || !b1 || !b2 || !g1 || !fur || !g2 || !chest) {
      return { placed: false };
    }
    drill.fuelBuf = 5;
    fur.fuelBuf = 5;
    // run 60 simulated seconds
    for (let i = 0; i < 1800; i++) simTick(1 / 30);
    return {
      placed: true,
      mined: G.stats.mined,
      smelted: G.stats.smelted,
      beltItems: b1.items.length + b2.items.length,
      chestIron: (chest.store['iron-ingot'] || 0),
      furnaceOut: fur.outCount,
    };
  });
  console.log('chain result:', JSON.stringify(result));
  check('all entities placed', result.placed);
  check('drill mined ore', result.mined > 10);
  check('furnace smelted ingots', result.smelted > 5);
  check('chest received iron ingots', result.chestIron > 3);

  // 3. Hand crafting
  const craft = await page.evaluate(() => {
    G.inv['iron-ingot'] = 10;
    const ok = queueHandCraft('gear');
    for (let i = 0; i < 90; i++) simTick(1 / 30);
    return { ok, gears: invCount('gear') };
  });
  check('hand-crafted a gear', craft.ok && craft.gears >= 1);

  // 4. Research flow
  const research = await page.evaluate(() => {
    G.inv['study'] = 1;
    const study = placeEntity('study', 40, 40, 0);
    study.packs.tome1 = 20;
    const started = startResearch('automation');
    for (let i = 0; i < 3000; i++) simTick(1 / 30);
    return { started, done: techDone('automation'), crafterUnlocked: entityUnlocked('crafter') };
  });
  console.log('research result:', JSON.stringify(research));
  check('research started', research.started);
  check('automation researched via study table', research.done);
  check('crafter unlocked by research', research.crafterUnlocked);

  // 5. Crafter automation
  const crafter = await page.evaluate(() => {
    G.inv['crafter'] = 1;
    const c = placeEntity('crafter', 50, 50, 0);
    if (!c) return { made: -1 };
    c.recipe = 'gear';
    c.input['iron-ingot'] = 10;
    for (let i = 0; i < 300; i++) simTick(1 / 30);
    return { made: c.output['gear'] || 0 };
  });
  check('crafter produced gears', crafter.made >= 2);

  // 6. Save / load round-trip
  const saveload = await page.evaluate(() => {
    const before = G.entities.size;
    const s = saveGame();
    loadGame(s);
    return { before, after: G.entities.size, techKept: techDone('automation') };
  });
  console.log('saveload:', JSON.stringify(saveload));
  check('save/load preserves entities', saveload.before === saveload.after && saveload.after > 0);
  check('save/load preserves research', saveload.techKept);

  // 7. UI interactions: open craft panel via keyboard, click a hotbar slot
  await page.keyboard.press('e');
  check('craft panel opens with E', await page.evaluate(() => !document.getElementById('panel-craft').classList.contains('hidden')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  check('tech panel opens with T', await page.evaluate(() => !document.getElementById('panel-tech').classList.contains('hidden')));
  await page.keyboard.press('Escape');

  // 8. Screenshot for the README
  await page.evaluate(() => {
    Renderer.cam.x = 22 * 16; Renderer.cam.y = 20 * 16; Renderer.cam.zoom = 3;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.resolve(__dirname, '..', 'docs', 'screenshot.png') });

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('PASS: no console or page errors');
  }
  await browser.close();
})();
