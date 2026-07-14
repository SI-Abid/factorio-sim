// BlockForge — bootstrap, game loop, save/load storage
'use strict';

const Main = {
  SAVE_KEY: 'blockforge-save-v1',
  TICK: 1 / 30,
  accum: 0,
  last: 0,

  init() {
    if (!this.loadFromStorage(false)) this.newGame();
    Renderer.init(document.getElementById('game'));
    UI.init();
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
    setInterval(() => this.saveToStorage(false), 60000); // autosave
  },

  newGame() {
    G.seed = (Math.random() * 0xffffffff) >>> 0;
    World.generate(G.seed);
    if (Renderer.ready) Renderer.redrawTerrain();
    G.inv = {};
    for (const k in STARTER_KIT) G.inv[k] = STARTER_KIT[k];
    G.creatures = [];
    G.peaceful = false;
    spawnDens();
    Renderer.cam.x = WORLD_W * TILE / 2;
    Renderer.cam.y = WORLD_H * TILE / 2;
  },

  frame(now) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    dt = Math.min(dt, 0.25); // don't spiral after a background tab
    this.accum += dt;
    while (this.accum >= this.TICK) {
      simTick(this.TICK);
      this.accum -= this.TICK;
    }
    UI.updateCamera(dt);
    UI.updateGhost();
    Renderer.draw({ buildSel: UI.buildSel, ghost: UI.ghost, hoverEnt: UI.hoverEnt });
    UI.drawFloats(dt);
    UI.drawFlashes(dt);
    requestAnimationFrame(t => this.frame(t));
  },

  saveToStorage(announce) {
    try {
      localStorage.setItem(this.SAVE_KEY, saveGame());
      if (announce) UI.toast('Game saved');
    } catch (err) {
      if (announce) UI.toast('Save failed: ' + err.message);
    }
  },

  loadFromStorage(announce) {
    try {
      const s = localStorage.getItem(this.SAVE_KEY);
      if (!s) { if (announce) UI.toast('No save found'); return false; }
      loadGame(s);
      if (announce) {
        UI.toast('Game loaded');
        UI.closeAllPanels();
        UI.refreshToolbar();
      }
      return true;
    } catch (err) {
      console.error('Load failed', err);
      if (announce) UI.toast('Load failed: ' + err.message);
      return false;
    }
  },
};

window.addEventListener('DOMContentLoaded', () => Main.init());
