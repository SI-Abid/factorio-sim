// BlockForge enemies test: pollution, creature dens, smoglings, turrets, walls, save/load.
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

  // ---------- 1. Pollution emission + decay ----------
  const pollution = await page.evaluate(() => {
    localStorage.clear();
    G.peaceful = true; // don't let a nearby den interfere with this test
    const x = 20, y = 20;
    for (let ty = y; ty < y + 2; ty++) for (let tx = x; tx < x + 2; tx++) {
      const i = World.idx(tx, ty);
      World.oreType[i] = 1; World.oreAmount[i] = 500;
    }
    G.inv['drill'] = 1; G.inv['coal'] = 50; G.inv['chest'] = 1;
    const drill = placeEntity('drill', x, y, 1);
    placeEntity('chest', x + 2, y, 0); // drains the drill's output so it stays continuously active
    drill.fuelBuf = 20;
    const before = World.pollutionAt(x, y);
    for (let i = 0; i < 900; i++) simTick(1 / 30); // 30 sim seconds of active mining
    const afterEmit = World.pollutionAt(x, y);
    const neighborAfterEmit = World.pollutionAt(x + POLLUTION_CELL, y); // diffusion spread
    removeEntity(drill); // stop emitting
    for (let i = 0; i < 3600; i++) simTick(1 / 30); // 120 sim seconds of decay, nothing burning
    const afterDecay = World.pollutionAt(x, y);
    return { before, afterEmit, neighborAfterEmit, afterDecay };
  });
  console.log('pollution:', JSON.stringify(pollution));
  check('pollution starts at zero', pollution.before === 0);
  check('active machine emits pollution into its cell', pollution.afterEmit > 5);
  check('pollution diffuses into a neighboring cell', pollution.neighborAfterEmit > 0);
  check('pollution decays once the source stops', pollution.afterDecay < pollution.afterEmit);

  // ---------- 2. Den spawning under pollution ----------
  const denSpawn = await page.evaluate(() => {
    G.peaceful = false;
    G.creatures = [];
    const dx = 100, dy = 100;
    const den = spawnDen(dx, dy);
    den.spawnTimer = 0.01;
    World.addPollution(dx + 1, dy + 1, DEN_SPAWN_THRESHOLD + 20);
    const before = G.creatures.length;
    simTick(0.02); // trip the spawn timer this tick
    const after = G.creatures.length;
    removeEntity(den);
    return { before, after, hasCreature: G.creatures.length > 0 };
  });
  console.log('denSpawn:', JSON.stringify(denSpawn));
  check('den spawns a smogling once pollution crosses the threshold', denSpawn.before === 0 && denSpawn.hasCreature);

  // ---------- 3. Smogling damages and destroys a conveyor (no refund) ----------
  const conveyorKill = await page.evaluate(() => {
    G.creatures = [];
    G.inv['conveyor'] = 1;
    const conv = placeEntity('conveyor', 60, 60, 0);
    const invBefore = invCount('conveyor');
    G.creatures.push({ id: G.nextId++, x: 60.5, y: 60.5, hp: SMOGLING_HP, target: conv.id });
    for (let i = 0; i < 300 && G.entities.has(conv.id); i++) simTick(1 / 30); // up to 10s
    return {
      destroyed: !G.entities.has(conv.id),
      invBefore,
      invAfter: invCount('conveyor'),
      tileFree: entityAt(60, 60) === null,
    };
  });
  console.log('conveyorKill:', JSON.stringify(conveyorKill));
  check('smogling destroys the conveyor', conveyorKill.destroyed);
  check('destroyed conveyor tile is cleared', conveyorKill.tileFree);
  check('no refund on creature-caused destruction', conveyorKill.invAfter === conveyorKill.invBefore);

  // ---------- 4. Bolt turret kills a smogling ----------
  const turretKill = await page.evaluate(() => {
    G.research.done['fortification'] = true; // bypass the tech gate for this direct placement
    G.creatures = [];
    G.inv['turret'] = 1; G.inv['bolt'] = 20;
    const turret = placeEntity('turret', 70, 70, 0);
    for (let i = 0; i < TURRET_AMMO_CAP && invCount('bolt') > 0; i++) { insertIntoEntity(turret, 'bolt'); invAdd('bolt', -1); }
    const ammoBefore = turret.ammo;
    G.creatures.push({ id: G.nextId++, x: 71, y: 70.5, hp: SMOGLING_HP, target: null });
    let ticks = 0;
    while (G.creatures.length > 0 && ticks < 300) { simTick(1 / 30); ticks++; }
    return { ammoBefore, ammoAfter: turret.ammo, killed: G.creatures.length === 0, ticks };
  });
  console.log('turretKill:', JSON.stringify(turretKill));
  check('turret was loaded with bolts', turretKill.ammoBefore > 0);
  check('turret fired (ammo spent)', turretKill.ammoAfter < turretKill.ammoBefore);
  check('turret kills the smogling within range', turretKill.killed);

  // ---------- 5. Wall blocks a smogling ----------
  const wallBlock = await page.evaluate(() => {
    G.creatures = [];
    G.inv['wall'] = 1;
    const wall = placeEntity('wall', 80, 80, 0);
    const hpBefore = wall.hp;
    // creature sits just west of the wall, with a far-away target straight through it
    G.inv['chest'] = 1;
    const farChest = placeEntity('chest', 83, 80, 0);
    const cr = { id: G.nextId++, x: 79.5, y: 80.5, hp: SMOGLING_HP, target: farChest.id };
    G.creatures.push(cr);
    for (let i = 0; i < 60; i++) simTick(1 / 30); // 2s: enough to reach & bump the wall, not to cross it
    return {
      hpBefore, hpAfter: wall.hp,
      stillBlocked: cr.x < 80, // never made it past the wall's tile
      wallStillThere: G.entities.has(wall.id),
    };
  });
  console.log('wallBlock:', JSON.stringify(wallBlock));
  check('wall takes damage from the blocked creature', wallBlock.hpAfter < wallBlock.hpBefore);
  check('wall blocks the creature from passing through', wallBlock.stillBlocked);
  check('wall (300 HP) survives a couple seconds of pecking', wallBlock.wallStillThere);

  // ---------- 6. Save/load round trip: creatures, pollution, peaceful ----------
  const roundTrip = await page.evaluate(() => {
    G.creatures = [{ id: G.nextId++, x: 12.3, y: 45.6, hp: 17, target: null }];
    G.peaceful = true;
    World.addPollution(50, 50, 123);
    const pollBefore = World.pollutionAt(50, 50);
    const s = saveGame();
    // mutate live state to prove load actually restores from the save, not leftover memory
    G.creatures = [];
    G.peaceful = false;
    World.addPollution(50, 50, 500);
    loadGame(s);
    return {
      creatureCount: G.creatures.length,
      creatureHp: G.creatures[0] && G.creatures[0].hp,
      peaceful: G.peaceful,
      pollBefore,
      pollAfter: World.pollutionAt(50, 50),
    };
  });
  console.log('roundTrip:', JSON.stringify(roundTrip));
  check('creatures round-trip through save/load', roundTrip.creatureCount === 1 && roundTrip.creatureHp === 17);
  check('peaceful flag round-trips through save/load', roundTrip.peaceful === true);
  check('pollution grid round-trips through save/load', Math.abs(roundTrip.pollAfter - roundTrip.pollBefore) < 0.001);

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('PASS: no console or page errors');
  }
  await browser.close();
})();
