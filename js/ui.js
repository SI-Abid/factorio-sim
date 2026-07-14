// BlockForge — input handling, hotbar, panels, tooltips
'use strict';

const UI = {
  buildSel: null,          // selected buildable type or null
  buildDir: 0,
  ghost: { type: null, gx: 0, gy: 0, dir: 0, ok: false },
  hoverEnt: null,
  hoverTile: null,
  openEnt: null,           // entity whose panel is open
  mouse: { x: 0, y: 0, down: false, panning: false, panStart: null },
  keys: {},
  dragPlacing: false,
  floats: [],              // floating "+1 Raw Iron" texts

  init() {
    const cv = Renderer.canvas;
    cv.addEventListener('mousedown', e => this.onMouseDown(e));
    window.addEventListener('mouseup', e => this.onMouseUp(e));
    cv.addEventListener('mousemove', e => this.onMouseMove(e));
    cv.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => this.onKeyDown(e));
    window.addEventListener('keyup', e => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('resize', () => Renderer.resize());

    this.buildToolbar();
    document.getElementById('btn-craft').onclick = () => this.togglePanel('panel-craft');
    document.getElementById('btn-tech').onclick = () => this.togglePanel('panel-tech');
    document.getElementById('btn-help').onclick = () => this.togglePanel('panel-help');
    document.getElementById('btn-save').onclick = () => Main.saveToStorage(true);
    document.getElementById('btn-load').onclick = () => Main.loadFromStorage(true);
    document.getElementById('btn-continue').onclick = () => {
      document.getElementById('victory').classList.add('hidden');
    };
    for (const el of document.querySelectorAll('.panel-close')) {
      el.onclick = () => this.closePanel(el.dataset.close);
    }
    setInterval(() => this.refreshOpenPanels(), 250);
  },

  // ---------- toolbar ----------
  buildToolbar() {
    const bar = document.getElementById('build-buttons');
    bar.innerHTML = '';
    BUILDABLE.forEach((type, i) => {
      const btn = document.createElement('button');
      btn.className = 'slot';
      btn.id = 'slot-' + type;
      btn.title = `${ENTITY_DEFS[type].name} (${i + 1})\n${ENTITY_DEFS[type].desc}`;
      const img = document.createElement('img');
      img.src = Renderer.iconURL(type);
      img.draggable = false;
      btn.appendChild(img);
      const badge = document.createElement('span');
      badge.className = 'count';
      btn.appendChild(badge);
      btn.onclick = () => this.selectBuild(type);
      bar.appendChild(btn);
    });
    this.refreshToolbar();
  },

  refreshToolbar() {
    BUILDABLE.forEach(type => {
      const btn = document.getElementById('slot-' + type);
      if (!btn) return;
      const n = invCount(type);
      const locked = !entityUnlocked(type);
      btn.querySelector('.count').textContent = n > 0 ? n : '';
      btn.classList.toggle('empty', n === 0 || locked);
      btn.classList.toggle('selected', this.buildSel === type);
      btn.classList.toggle('locked', locked);
    });
  },

  selectBuild(type) {
    if (!entityUnlocked(type)) { this.toast('Locked — research it first'); return; }
    if (invCount(type) < 1) { this.toast('None in inventory — craft some (E)'); return; }
    this.buildSel = (this.buildSel === type) ? null : type;
    this.refreshToolbar();
  },

  cancelBuild() { this.buildSel = null; this.dragPlacing = false; this.refreshToolbar(); },

  // ---------- mouse ----------
  eventTile(e) {
    const r = Renderer.canvas.getBoundingClientRect();
    const [wx, wy] = Renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    return [Math.floor(wx), Math.floor(wy)];
  },

  onMouseDown(e) {
    if (e.button === 1) {
      this.mouse.panning = true;
      this.mouse.panStart = { x: e.clientX, y: e.clientY, cx: Renderer.cam.x, cy: Renderer.cam.y };
      e.preventDefault();
      return;
    }
    const [tx, ty] = this.eventTile(e);
    if (e.button === 2) {
      // right-click: cancel selection, else remove entity
      if (this.buildSel) { this.cancelBuild(); return; }
      const ent = entityAt(tx, ty);
      if (ent) {
        if (this.openEnt === ent) this.closePanel('panel-entity');
        removeEntity(ent);
        this.toast(ENTITY_DEFS[ent.type].name + ' removed (refunded)');
        this.refreshToolbar();
      }
      return;
    }
    if (e.button !== 0) return;
    this.mouse.down = true;

    if (this.buildSel) {
      this.tryPlaceAt(tx, ty);
      this.dragPlacing = true;
      return;
    }
    const ent = entityAt(tx, ty);
    if (ent) { this.openEntityPanel(ent); return; }
    if (World.oreAt(tx, ty)) {
      G.handMine = { x: tx, y: ty, t: 0 };
    }
  },

  onMouseUp(e) {
    if (e.button === 1) this.mouse.panning = false;
    if (e.button === 0) {
      this.mouse.down = false;
      this.dragPlacing = false;
      G.handMine = null;
    }
  },

  onMouseMove(e) {
    const r = Renderer.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;

    if (this.mouse.panning && this.mouse.panStart) {
      const z = Renderer.cam.zoom;
      Renderer.cam.x = this.mouse.panStart.cx - (e.clientX - this.mouse.panStart.x) / z;
      Renderer.cam.y = this.mouse.panStart.cy - (e.clientY - this.mouse.panStart.y) / z;
      this.clampCamera();
      return;
    }
    const [tx, ty] = this.eventTile(e);
    this.hoverTile = [tx, ty];
    this.hoverEnt = entityAt(tx, ty);

    if (this.buildSel && this.dragPlacing && this.mouse.down) this.tryPlaceAt(tx, ty);
    if (G.handMine && (G.handMine.x !== tx || G.handMine.y !== ty) && this.mouse.down && !this.buildSel) {
      G.handMine = World.oreAt(tx, ty) ? { x: tx, y: ty, t: 0 } : null;
    }
    this.updateTooltip(e.clientX, e.clientY);
  },

  onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const z0 = Renderer.cam.zoom;
    const z1 = Math.max(1, Math.min(5, z0 * factor));
    if (z1 === z0) return;
    // zoom around cursor
    const r = Renderer.canvas.getBoundingClientRect();
    const [wx, wy] = Renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    Renderer.cam.zoom = z1;
    const [sx2, sy2] = Renderer.worldToScreen(wx, wy);
    Renderer.cam.x += (sx2 - (e.clientX - r.left)) / z1;
    Renderer.cam.y += (sy2 - (e.clientY - r.top)) / z1;
    this.clampCamera();
  },

  clampCamera() {
    const c = Renderer.cam;
    c.x = Math.max(0, Math.min(WORLD_W * TILE, c.x));
    c.y = Math.max(0, Math.min(WORLD_H * TILE, c.y));
  },

  tryPlaceAt(tx, ty) {
    const type = this.buildSel;
    if (!type) return;
    if (invCount(type) < 1) { this.cancelBuild(); this.toast('Out of ' + ENTITY_DEFS[type].name + 's'); return; }
    const e = placeEntity(type, tx, ty, this.buildDir);
    if (e) {
      this.refreshToolbar();
      if (invCount(type) === 0) this.cancelBuild();
    }
  },

  // ---------- keyboard ----------
  onKeyDown(e) {
    const k = e.key.toLowerCase();
    if (e.target.tagName === 'INPUT') return;
    this.keys[k] = true;
    if (k === 'r' && this.buildSel) { this.buildDir = (this.buildDir + 1) % 4; }
    else if (k === 'q') this.cancelBuild();
    else if (k === 'e') this.togglePanel('panel-craft');
    else if (k === 't') this.togglePanel('panel-tech');
    else if (k === 'h') this.togglePanel('panel-help');
    else if (k === 'escape') {
      if (this.buildSel) this.cancelBuild();
      else this.closeAllPanels();
    } else if (k >= '1' && k <= '9') {
      const type = BUILDABLE[+k - 1];
      if (type) this.selectBuild(type);
    } else if (k === '0') {
      const type = BUILDABLE[9];
      if (type) this.selectBuild(type);
    }
  },

  // camera pan from held keys; called each frame
  updateCamera(dt) {
    const sp = 420 / Renderer.cam.zoom * dt;
    if (this.keys['w'] || this.keys['arrowup']) Renderer.cam.y -= sp;
    if (this.keys['s'] || this.keys['arrowdown']) Renderer.cam.y += sp;
    if (this.keys['a'] || this.keys['arrowleft']) Renderer.cam.x -= sp;
    if (this.keys['d'] || this.keys['arrowright']) Renderer.cam.x += sp;
    this.clampCamera();
  },

  // ---------- ghost state for renderer ----------
  updateGhost() {
    if (!this.buildSel || !this.hoverTile) return;
    const [tx, ty] = this.hoverTile;
    this.ghost.type = this.buildSel;
    this.ghost.gx = tx; this.ghost.gy = ty;
    this.ghost.dir = this.buildDir;
    this.ghost.ok = canPlace(this.buildSel, tx, ty, this.buildDir) && invCount(this.buildSel) > 0;
  },

  // ---------- panels ----------
  togglePanel(id) {
    const el = document.getElementById(id);
    const wasHidden = el.classList.contains('hidden');
    this.closeAllPanels();
    if (wasHidden) {
      el.classList.remove('hidden');
      if (id === 'panel-craft') this.renderCraftPanel();
      if (id === 'panel-tech') this.renderTechPanel();
    }
  },
  closePanel(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'panel-entity') this.openEnt = null;
  },
  closeAllPanels() {
    for (const id of ['panel-craft', 'panel-tech', 'panel-entity', 'panel-help']) this.closePanel(id);
  },
  refreshOpenPanels() {
    if (!document.getElementById('panel-craft').classList.contains('hidden')) this.renderCraftPanel();
    if (!document.getElementById('panel-tech').classList.contains('hidden')) this.renderTechPanel();
    if (this.openEnt) {
      if (!G.entities.has(this.openEnt.id)) this.closePanel('panel-entity');
      else this.renderEntityPanel();
    }
    this.refreshToolbar();
    this.updateHud();
  },

  iconImg(id, sz) {
    return `<img class="icon" src="${Renderer.iconURL(id)}" width="${sz || 16}" height="${sz || 16}" draggable="false">`;
  },

  renderCraftPanel() {
    const list = document.getElementById('craft-list');
    let html = '';
    for (const r of RECIPES) {
      if (r.station !== 'craft') continue;
      if (!recipeUnlocked(r)) continue;
      const ok = canAfford(r.in);
      const ing = Object.entries(r.in).map(([it, n]) =>
        `<span class="ing ${invCount(it) >= n ? '' : 'missing'}">${this.iconImg(it)}${n}</span>`).join(' ');
      html += `<div class="recipe ${ok ? '' : 'unaffordable'}" data-recipe="${r.id}">
        ${this.iconImg(r.out, 24)}
        <span class="rname">${ITEMS[r.out].name}${r.n > 1 ? ' ×' + r.n : ''}</span>
        <span class="ings">${ing}</span>
        <button class="mini-btn" data-craft="${r.id}" ${ok ? '' : 'disabled'}>Craft</button>
        <button class="mini-btn" data-craft5="${r.id}" ${ok ? '' : 'disabled'}>×5</button>
      </div>`;
    }
    if (G.craftQueue.length) {
      html += `<div class="queue">Crafting: ${G.craftQueue.map(j => this.iconImg(RECIPE_BY_ID[j.recipe].out)).join('')}</div>`;
    }
    list.innerHTML = html;
    for (const b of list.querySelectorAll('[data-craft]')) b.onclick = () => { queueHandCraft(b.dataset.craft); this.renderCraftPanel(); };
    for (const b of list.querySelectorAll('[data-craft5]')) b.onclick = () => { for (let i = 0; i < 5; i++) queueHandCraft(b.dataset.craft5); this.renderCraftPanel(); };

    // inventory grid
    const inv = document.getElementById('inv-list');
    let ih = '';
    const keys = Object.keys(G.inv).sort();
    for (const it of keys) {
      ih += `<div class="inv-slot" title="${ITEMS[it].name}">${this.iconImg(it, 20)}<span class="count">${G.inv[it]}</span></div>`;
    }
    inv.innerHTML = ih || '<i>empty</i>';
  },

  renderTechPanel() {
    const list = document.getElementById('tech-list');
    let html = '';
    for (const t of TECHS) {
      const done = techDone(t.id);
      const reqOk = t.req.every(r => techDone(r));
      const current = G.research.current === t.id;
      const packs = t.packs.map(p => this.iconImg(p)).join('');
      let status;
      if (done) status = '<span class="done">✓ researched</span>';
      else if (current) status = `<span class="prog">${G.research.progress}/${t.units}</span>`;
      else if (!reqOk) status = `<span class="locked">requires: ${t.req.map(r => TECH_BY_ID[r].name).join(', ')}</span>`;
      else status = `<button class="mini-btn" data-research="${t.id}">Research</button>`;
      html += `<div class="tech ${done ? 'tech-done' : ''} ${current ? 'tech-current' : ''}">
        <div class="tech-head"><b>${t.name}</b> <span class="tech-cost">${t.units}× ${packs}</span></div>
        <div class="tech-desc">${t.desc}</div>
        <div class="tech-status">${status}</div>
      </div>`;
    }
    list.innerHTML = html;
    for (const b of list.querySelectorAll('[data-research]')) {
      b.onclick = () => {
        if (startResearch(b.dataset.research)) this.toast('Researching: ' + TECH_BY_ID[b.dataset.research].name);
        this.renderTechPanel();
      };
    }
  },

  openEntityPanel(ent) {
    this.closeAllPanels();
    this.openEnt = ent;
    document.getElementById('panel-entity').classList.remove('hidden');
    this.renderEntityPanel();
  },

  renderEntityPanel() {
    const e = this.openEnt;
    if (!e) return;
    document.getElementById('entity-title').textContent = ENTITY_DEFS[e.type].name;
    const body = document.getElementById('entity-body');
    let html = `<div class="ent-desc">${ENTITY_DEFS[e.type].desc}</div>`;
    const fuelRow = () => `<div class="row">Fuel: ${this.iconImg('coal')} ×${e.fuelBuf}
      <span class="fuelbar"><span style="width:${Math.min(100, e.fuel / FUEL_PER_COAL * 100)}%"></span></span>
      <button class="mini-btn" data-act="fuel" ${invCount('coal') ? '' : 'disabled'}>+5 coal</button></div>`;

    switch (e.type) {
      case 'drill': {
        html += fuelRow();
        html += `<div class="row">Output buffer: ${e.outBuf.map(i => this.iconImg(i)).join('') || '<i>empty</i>'}
          ${e.outBuf.length ? '<button class="mini-btn" data-act="takeout">Take</button>' : ''}</div>`;
        html += `<div class="row">Status: ${e.active ? 'mining' : (e.fuelBuf || e.fuel > 0 ? 'idle (output blocked or no ore)' : 'no fuel')}</div>`;
        break;
      }
      case 'furnace': {
        html += fuelRow();
        html += `<div class="row">Input: ${e.inItem ? this.iconImg(e.inItem) + ' ×' + e.inCount : '<i>empty</i>'}`;
        for (const it of ['raw-iron', 'raw-copper', 'stone']) {
          if (invCount(it) > 0 && (e.inItem === null || e.inItem === it)) {
            html += ` <button class="mini-btn" data-act="feed" data-item="${it}">+5 ${ITEMS[it].name}</button>`;
          }
        }
        html += `</div>`;
        html += `<div class="row">Progress: <span class="fuelbar"><span style="width:${e.progress * 100}%"></span></span></div>`;
        html += `<div class="row">Output: ${e.outItem ? this.iconImg(e.outItem) + ' ×' + e.outCount : '<i>empty</i>'}
          ${e.outCount ? '<button class="mini-btn" data-act="takeout">Take</button>' : ''}</div>`;
        break;
      }
      case 'chest': {
        let total = 0; for (const k in e.store) total += e.store[k];
        html += `<div class="row">Stored ${total}/${CHEST_CAP}</div><div class="icon-grid">`;
        for (const k of Object.keys(e.store).sort()) {
          html += `<div class="inv-slot" title="${ITEMS[k].name}">${this.iconImg(k, 20)}<span class="count">${e.store[k]}</span></div>`;
        }
        html += `</div>`;
        html += `<div class="row"><button class="mini-btn" data-act="takeall">Take all</button></div>`;
        html += `<div class="row">Deposit: `;
        for (const it of Object.keys(G.inv).sort().slice(0, 8)) {
          html += `<button class="mini-btn" data-act="deposit" data-item="${it}" title="${ITEMS[it].name}">${this.iconImg(it)}×10</button> `;
        }
        html += `</div>`;
        break;
      }
      case 'crafter': {
        const options = RECIPES.filter(r => r.station === 'craft' && recipeUnlocked(r));
        html += `<div class="row">Recipe: <select id="crafter-recipe">
          <option value="">— none —</option>
          ${options.map(r => `<option value="${r.id}" ${e.recipe === r.id ? 'selected' : ''}>${ITEMS[r.out].name}</option>`).join('')}
        </select></div>`;
        if (e.recipe) {
          const r = RECIPE_BY_ID[e.recipe];
          html += `<div class="row">Input: `;
          for (const k in r.in) {
            html += `<span class="ing">${this.iconImg(k)}${e.input[k] || 0}/${r.in[k]}</span>
              <button class="mini-btn" data-act="feedcrafter" data-item="${k}" ${invCount(k) ? '' : 'disabled'}>+5</button> `;
          }
          html += `</div>`;
          html += `<div class="row">Progress: <span class="fuelbar"><span style="width:${e.progress * 100}%"></span></span></div>`;
          const outN = e.output[r.out] || 0;
          html += `<div class="row">Output: ${this.iconImg(r.out)} ×${outN}
            ${outN ? '<button class="mini-btn" data-act="takeout">Take</button>' : ''}</div>`;
        }
        break;
      }
      case 'study': {
        html += `<div class="row">Tomes: ${this.iconImg('tome1')} ×${e.packs.tome1 || 0}
          <button class="mini-btn" data-act="feedstudy" data-item="tome1" ${invCount('tome1') ? '' : 'disabled'}>+5</button>
          &nbsp; ${this.iconImg('tome2')} ×${e.packs.tome2 || 0}
          <button class="mini-btn" data-act="feedstudy" data-item="tome2" ${invCount('tome2') ? '' : 'disabled'}>+5</button></div>`;
        const cur = G.research.current;
        html += `<div class="row">${cur ? 'Researching: ' + TECH_BY_ID[cur].name + ` (${G.research.progress}/${TECH_BY_ID[cur].units})` : 'No research selected — open Tech (T)'}</div>`;
        break;
      }
      case 'conveyor': case 'fast-conveyor': {
        html += `<div class="row">Items on belt: ${e.items.map(i => this.iconImg(i.item)).join('') || '<i>none</i>'}</div>`;
        break;
      }
      case 'grabber': {
        html += `<div class="row">Holding: ${e.hold ? this.iconImg(e.hold) : '<i>nothing</i>'}</div>
          <div class="row">Picks up from the ${DIR_NAMES[oppositeDir(e.dir)]} side, drops to the ${DIR_NAMES[e.dir]} side.</div>`;
        break;
      }
      case 'splitter': {
        html += `<div class="row">Buffer: ${e.buf.map(i => this.iconImg(i.item)).join('') || '<i>empty</i>'}</div>`;
        html += `<div class="row">Next output goes to side ${e.nextOut === 0 ? 'A' : 'B'} (alternates each item).</div>`;
        break;
      }
      case 'tunnel-belt': {
        const roleLabel = e.role === 'exit' ? 'Exit' : 'Entrance';
        html += `<div class="row">Role: ${roleLabel}${e.pairId === null ?
          ' — <i>unpaired, place another Tunnel Belt facing the same way within 4 tiles</i>' : ''}</div>`;
        if (e.role === 'entrance') {
          html += `<div class="row">In transit: ${e.queue.length ? e.queue.map(q => this.iconImg(q.item)).join('') : '<i>none</i>'}</div>`;
        }
        break;
      }
    }
    body.innerHTML = html;

    // wire up actions
    const takeN = (fn) => { let it; let n = 0; while (n < 999 && (it = fn())) { invAdd(it, 1); n++; } };
    for (const b of body.querySelectorAll('[data-act]')) {
      b.onclick = () => {
        const act = b.dataset.act, item = b.dataset.item;
        switch (act) {
          case 'fuel':
            for (let i = 0; i < 5 && invCount('coal') > 0 && e.fuelBuf < 5; i++) { invAdd('coal', -1); e.fuelBuf++; }
            break;
          case 'feed':
            for (let i = 0; i < 5 && invCount(item) > 0; i++) {
              if (!insertIntoEntity(e, item)) break;
              invAdd(item, -1);
            }
            break;
          case 'feedcrafter': case 'feedstudy':
            for (let i = 0; i < 5 && invCount(item) > 0; i++) {
              if (!insertIntoEntity(e, item)) break;
              invAdd(item, -1);
            }
            break;
          case 'takeout': takeN(() => extractFromEntity(e)); break;
          case 'takeall':
            for (const k of Object.keys(e.store)) { invAdd(k, e.store[k]); delete e.store[k]; }
            break;
          case 'deposit':
            for (let i = 0; i < 10 && invCount(item) > 0; i++) {
              if (!insertIntoEntity(e, item)) break;
              invAdd(item, -1);
            }
            break;
        }
        this.renderEntityPanel();
        this.refreshToolbar();
      };
    }
    const sel = body.querySelector('#crafter-recipe');
    if (sel) {
      sel.onchange = () => {
        // return current contents to player when switching recipes
        for (const k in e.input) invAdd(k, e.input[k]);
        for (const k in e.output) invAdd(k, e.output[k]);
        e.input = {}; e.output = {}; e.progress = 0;
        e.recipe = sel.value || null;
        this.renderEntityPanel();
      };
    }
  },

  // ---------- HUD ----------
  updateHud() {
    const rh = document.getElementById('research-hud');
    const cur = G.research.current;
    if (cur) {
      rh.classList.remove('hidden');
      const t = TECH_BY_ID[cur];
      document.getElementById('research-name').textContent = t.name;
      document.getElementById('research-bar').style.width = (G.research.progress / t.units * 100) + '%';
    } else {
      rh.classList.add('hidden');
    }
    document.getElementById('hint').textContent = this.currentHint();

    if (G.victory && !G.victoryShown) {
      G.victoryShown = true;
      document.getElementById('victory').classList.remove('hidden');
    }
  },

  currentHint() {
    const s = G.stats;
    if (s.mined < 5) return 'Hold left-click on an ore patch to mine by hand';
    if (!s.placed['drill']) return 'Select the Auto-Drill in the hotbar (key 3) and place it on ore. R rotates';
    if (!s.placed['furnace']) return 'Place a Furnace (key 4). Click machines to fuel them with coal';
    if (s.smelted < 5) return 'Click the drill & furnace to add coal. Connect them with conveyors + grabbers';
    if (invCount('tome1') === 0 && !s.placed['study']) return 'Craft Basic Tomes (E), then place a Study Table';
    if (!G.research.current && Object.keys(G.research.done).length === 0) return 'Feed tomes into the Study Table and pick a technology (T)';
    if (!techDone('omega')) return 'Automate everything. Research Omega Research to win';
    return 'The forge grows. Keep building!';
  },

  // ---------- tooltip / toast / floats ----------
  updateTooltip(cx, cy) {
    const tip = document.getElementById('tooltip');
    const e = this.hoverEnt;
    if (!e || this.buildSel) { tip.classList.add('hidden'); return; }
    let text = `<b>${ENTITY_DEFS[e.type].name}</b>`;
    if (e.type === 'drill' || e.type === 'furnace') text += `<br>fuel: ${e.fuelBuf} coal${e.active ? ' · working' : ''}`;
    if (e.type === 'furnace' && e.outCount) text += `<br>out: ${e.outCount} ${ITEMS[e.outItem].name}`;
    if (e.type === 'chest') { let t2 = 0; for (const k in e.store) t2 += e.store[k]; text += `<br>${t2} items`; }
    if (e.type === 'crafter') text += `<br>${e.recipe ? 'making ' + ITEMS[RECIPE_BY_ID[e.recipe].out].name : 'no recipe set'}`;
    if (e.type === 'splitter') text += `<br>buffer: ${e.buf.length}/${SPLITTER_BUF_CAP}`;
    if (e.type === 'tunnel-belt') text += `<br>${e.role}${e.pairId === null ? ' (unpaired)' : ''}`;
    text += '<br><i>click to open · right-click to remove</i>';
    tip.innerHTML = text;
    tip.classList.remove('hidden');
    tip.style.left = (cx + 16) + 'px';
    tip.style.top = (cy + 12) + 'px';
  },

  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 2200);
  },

  floatText(text, tx, ty) {
    this.floats.push({ text, x: tx + 0.5, y: ty, t: 1 });
    if (this.floats.length > 12) this.floats.shift();
  },

  drawFloats(dt) {
    const ctx = Renderer.ctx;
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    for (const f of this.floats) {
      f.t -= dt * 0.8;
      f.y -= dt * 0.8;
      if (f.t <= 0) continue;
      const [sx, sy] = Renderer.worldToScreen(f.x, f.y);
      ctx.globalAlpha = Math.min(1, f.t);
      ctx.fillStyle = '#111';
      ctx.fillText(f.text, sx + 1, sy + 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(f.text, sx, sy);
      ctx.globalAlpha = 1;
    }
    this.floats = this.floats.filter(f => f.t > 0);
  },
};
