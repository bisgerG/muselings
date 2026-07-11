/**
 * save.js — 前端存檔模組（零後端）
 * localStorage 為主，失敗時（如 Safari 無痕模式）降級為記憶體存檔。
 * key 帶 schema 版本號，未來改版時可寫遷移邏輯。
 */
(function () {
  const SAVE_KEY = 'museling_save_v1';
  let memoryFallback = null; // localStorage 不可用時的暫存

  function defaultSave() {
    return {
      schemaVersion: 1,
      player: { title: '生活探索者', createdAt: new Date().toISOString() },
      dex: {},
      items: {}
    };
  }

  function load() {
    if (memoryFallback) return memoryFallback;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return defaultSave();
      const save = JSON.parse(raw);
      if (save.schemaVersion !== 1) {
        // 未來版本在此做遷移；遷移邏輯就緒前先備份舊檔，避免直接歸零玩家進度
        try { localStorage.setItem(SAVE_KEY + '_backup', raw); } catch (e2) { /* ignore */ }
        return defaultSave();
      }
      return save;
    } catch (e) {
      console.warn('[save] localStorage 讀取失敗，使用記憶體存檔', e);
      memoryFallback = memoryFallback || defaultSave();
      return memoryFallback;
    }
  }

  function write(save) {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    } catch (e) {
      console.warn('[save] localStorage 寫入失敗，改用記憶體存檔', e);
      memoryFallback = save;
    }
  }

  function unlock(muselingId, extra) {
    const save = load();
    save.dex[muselingId] = Object.assign(
      { unlocked: true, caughtAt: new Date().toISOString() },
      save.dex[muselingId] || {},
      extra || {}
    );
    write(save);
    return save;
  }

  function isUnlocked(muselingId) {
    const entry = load().dex[muselingId];
    return !!(entry && entry.unlocked);
  }

  function reset() {
    memoryFallback = null;
    try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
  }

  window.MuselingSave = { load, write, unlock, isUnlocked, reset };
})();
