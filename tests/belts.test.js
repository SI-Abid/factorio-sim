// BlockForge belt-upgrade test: two-lane conveyors, splitters, tunnel belts.
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
  await page.waitForTimeout(300);

  const check = (name, val) => { console.log((val ? 'PASS' : 'FAIL') + ': ' + name); if (!val) process.exitCode = 1; };

  // Common setup: unlock logistics tech (splitter/tunnel-belt) and stock the inventory.
  await page.evaluate(() => {
    localStorage.clear();
    G.research.done['logistics'] = true;
    G.inv['conveyor'] = 50;
    G.inv['splitter'] = 10;
    G.inv['tunnel-belt'] = 10;
    G.inv['iron-ingot'] = 50;
    G.inv['gear'] = 50;
    G.inv['circuit'] = 50;
  });

  // ---------------------------------------------------------------
  // 1. Lane preservation across a straight belt-to-belt transfer,
  //    and near-lane assignment on a perpendicular side-load.
  // ---------------------------------------------------------------
  const laneResult = await page.evaluate(() => {
    const x = 10, y = 10;
    const a = placeEntity('conveyor', x, y, 1);     // faces East
    const b = placeEntity('conveyor', x + 1, y, 1);  // faces East (straight continuation)
    // put one item on each lane of `a`, right at the front edge
    beltAddItem(a, 'gear', 0.97, 0);      // left lane
    beltAddItem(a, 'iron-ingot', 0.5, 1); // right lane, further back so it doesn't collide
    for (let i = 0; i < 40; i++) simTick(1 / 30); // 1.3s: plenty of time to cross onto b
    const laneOf = (belt, item) => { const it = belt.items.find(i => i.item === item); return it ? it.lane : null; };

    // side-load case: a belt feeding into the SIDE of a perpendicular belt
    const sx = 20, sy = 20;
    const feeder = placeEntity('conveyor', sx, sy, 1);       // faces East, feeds into (sx+1,sy)
    const perpBelt = placeEntity('conveyor', sx + 1, sy, 2); // faces South (perpendicular turn)
    beltAddItem(feeder, 'wire', 0.97, 0);
    for (let i = 0; i < 40; i++) simTick(1 / 30);

    return {
      straightPlaced: !!a && !!b,
      bHasGear: laneOf(b, 'gear'),
      bHasIron: laneOf(b, 'iron-ingot'),
      sidePlaced: !!feeder && !!perpBelt,
      perpItems: perpBelt.items.map(i => ({ item: i.item, lane: i.lane })),
    };
  });
  console.log('lane result:', JSON.stringify(laneResult));
  check('straight-belt entities placed', laneResult.straightPlaced);
  check('left-lane item kept lane 0 across transfer', laneResult.bHasGear === 0);
  check('right-lane item kept lane 1 across transfer', laneResult.bHasIron === 1);
  check('side-load entities placed', laneResult.sidePlaced);
  check('side-loaded item landed on the perpendicular belt', laneResult.perpItems.length === 1 && laneResult.perpItems[0].item === 'wire');
  // feeder approaches from the west, which is the South-facing belt's right (lane 1) side
  check('side-loaded item landed on the near (right) lane', laneResult.perpItems[0] && laneResult.perpItems[0].lane === 1);

  // ---------------------------------------------------------------
  // 2. Splitter: round-robins its input across the two output belts.
  // ---------------------------------------------------------------
  const splitResult = await page.evaluate(() => {
    const x = 10, y = 30;
    const inBelt = placeEntity('conveyor', x - 1, y, 1);       // feeds splitter channel 0
    const splitter = placeEntity('splitter', x, y, 1);          // 2 tiles: (x,y) and (x,y+1)
    const outA = placeEntity('conveyor', x + 1, y, 1);          // channel 0 output
    const outB = placeEntity('conveyor', x + 1, y + 1, 1);      // channel 1 output
    if (!inBelt || !splitter || !outA || !outB) return { placed: false };
    // queue 4 evenly spaced items on the input belt (spacing > BELT_GAP with margin
    // to spare, since e.g. 0.65 and 0.95 are exactly 0.3 apart but float subtraction
    // rounds that a hair under BELT_GAP and would silently reject the add)
    for (const p of [0.02, 0.34, 0.66, 0.98]) beltAddItem(inBelt, 'circuit', p, 0);
    for (let i = 0; i < 150; i++) simTick(1 / 30); // 5s: plenty for the splitter to drain+refill repeatedly
    return {
      placed: true,
      inLeft: inBelt.items.length,
      splitterBuf: splitter.buf.length,
      outACount: outA.items.length,
      outBCount: outB.items.length,
    };
  });
  console.log('splitter result:', JSON.stringify(splitResult));
  check('splitter + belts placed', splitResult.placed);
  check('input belt drained into the splitter', splitResult.inLeft === 0);
  check('splitter buffer settled empty', splitResult.splitterBuf === 0);
  check('items split evenly between the two outputs (round-robin)', splitResult.outACount === 2 && splitResult.outBCount === 2);

  // ---------------------------------------------------------------
  // 3. Tunnel belt: end-to-end delivery across a gap, preserving lane.
  // ---------------------------------------------------------------
  const tunnelResult = await page.evaluate(() => {
    const x = 10, y = 50;
    const entrance = placeEntity('tunnel-belt', x, y, 1);        // faces East
    const exit = placeEntity('tunnel-belt', x + 3, y, 1);        // 3 tiles ahead, faces East -> pairs as exit
    const outBelt = placeEntity('conveyor', x + 4, y, 1);        // receives what the exit spits out
    if (!entrance || !exit || !outBelt) return { placed: false };
    const paired = entrance.role === 'entrance' && exit.role === 'exit' && entrance.pairId === exit.id;
    tunnelAccept(entrance, 'circuit', 1); // feed a right-lane item into the entrance
    const beforeDeliveryTicks = 20; // 0.67s < the ~2s transit delay (3 tiles / 1.5 tiles-per-sec)
    for (let i = 0; i < beforeDeliveryTicks; i++) simTick(1 / 30);
    const midTransit = outBelt.items.length === 0 && entrance.queue.length === 1;
    for (let i = 0; i < 100; i++) simTick(1 / 30); // run well past the transit delay
    return {
      placed: true,
      paired,
      midTransit,
      delivered: outBelt.items.length === 1,
      deliveredItem: outBelt.items[0] ? outBelt.items[0].item : null,
      deliveredLane: outBelt.items[0] ? outBelt.items[0].lane : null,
      entranceQueueEmpty: entrance.queue.length === 0,
    };
  });
  console.log('tunnel result:', JSON.stringify(tunnelResult));
  check('tunnel-belt pair placed and auto-linked as entrance/exit', tunnelResult.placed && tunnelResult.paired);
  check('item is mid-transit before the delay elapses', tunnelResult.midTransit);
  check('item delivered onto the belt past the exit', tunnelResult.delivered);
  check('delivered item id preserved', tunnelResult.deliveredItem === 'circuit');
  check('delivered item lane preserved', tunnelResult.deliveredLane === 1);
  check('entrance queue drained after delivery', tunnelResult.entranceQueueEmpty);

  // ---------------------------------------------------------------
  // 4. Save/load round trip preserves lanes, splitter state, and tunnel-belt pairing.
  // ---------------------------------------------------------------
  const saveResult = await page.evaluate(() => {
    const x = 10, y = 70;
    const belt = placeEntity('conveyor', x, y, 1);
    beltAddItem(belt, 'gear', 0.2, 0);
    beltAddItem(belt, 'wire', 0.8, 1);

    const sx = 10, sy = 80;
    const splitter = placeEntity('splitter', sx, sy, 1);
    splitter.buf.push({ item: 'circuit', lane: 1 });

    const tx = 10, ty = 90;
    const entrance = placeEntity('tunnel-belt', tx, ty, 1);
    const exit = placeEntity('tunnel-belt', tx + 2, ty, 1);
    tunnelAccept(entrance, 'iron-ingot', 0);

    const before = {
      entities: G.entities.size,
      beltLanes: belt.items.map(i => [i.item, i.lane]).sort(),
      splitterBuf: JSON.stringify(splitter.buf),
      tunnelPaired: entrance.pairId === exit.id && exit.pairId === entrance.id,
      tunnelQueue: JSON.stringify(entrance.queue),
    };

    const json = saveGame();
    loadGame(json);

    const belt2 = entityAt(x, y);
    const splitter2 = entityAt(sx, sy);
    const entrance2 = entityAt(tx, ty);
    const exit2 = entityAt(tx + 2, ty);
    const after = {
      entities: G.entities.size,
      beltLanes: belt2.items.map(i => [i.item, i.lane]).sort(),
      splitterBuf: JSON.stringify(splitter2.buf),
      tunnelPaired: entrance2.pairId === exit2.id && exit2.pairId === entrance2.id,
      tunnelQueue: JSON.stringify(entrance2.queue),
      entranceRole: entrance2.role,
      exitRole: exit2.role,
    };
    return { before, after };
  });
  console.log('save/load result:', JSON.stringify(saveResult));
  check('save/load preserves entity count', saveResult.before.entities === saveResult.after.entities);
  check('save/load preserves belt lanes', JSON.stringify(saveResult.before.beltLanes) === JSON.stringify(saveResult.after.beltLanes));
  check('save/load preserves splitter buffer', saveResult.before.splitterBuf === saveResult.after.splitterBuf);
  check('save/load preserves tunnel-belt pairing', saveResult.before.tunnelPaired && saveResult.after.tunnelPaired);
  check('save/load preserves tunnel-belt roles', saveResult.after.entranceRole === 'entrance' && saveResult.after.exitRole === 'exit');
  check('save/load preserves tunnel-belt in-transit queue', saveResult.before.tunnelQueue === saveResult.after.tunnelQueue);

  if (errors.length) {
    console.log('CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 1;
  } else {
    console.log('PASS: no console or page errors');
  }
  await browser.close();
})();
