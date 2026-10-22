/* ============================================================
 * Playable Novel Engine · 存储层
 * IndexedDB 主存储 + localStorage 降级 + 旧数据自动迁移
 *
 * Stores:
 *  config    key-value  配置与 UI 偏好
 *  novel     key-value  当前小说 { title, chapters, fullText }
 *  progress  key-value  当前进度（含记忆体/分支/用量统计）
 *  saves     自增 id    分支快照 { name, createdAt, snapshot }
 *  worldbook 自增 id    世界书条目 { type, name, content, mode, keywords }
 *  gallery   key-value  场景插画缓存
 * ============================================================ */

const PN_DB_NAME = 'playable-novel';
const PN_DB_VERSION = 1;
const PN_STORE = { config: 'config', novel: 'novel', progress: 'progress', saves: 'saves', worldbook: 'worldbook', gallery: 'gallery' };
const PN_LS_KEYS = { config: 'pn-config', progress: 'playable-novel-state-v1' };

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB 不可用'));
    let req;
    try {
      req = indexedDB.open(PN_DB_NAME, PN_DB_VERSION);
    } catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(PN_STORE)) {
        if (db.objectStoreNames.contains(name)) continue;
        if (name === PN_STORE.saves || name === PN_STORE.worldbook) {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        } else {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return _dbPromise;
}

/* ---------- localStorage 降级适配器（隐私模式等场景） ---------- */
const LSAdapter = {
  _k: store => `pn3:${store}`,
  async get(store, key) {
    const raw = localStorage.getItem(this._k(store));
    if (!raw) return undefined;
    const obj = JSON.parse(raw);
    return obj[key];
  },
  async set(store, key, value) {
    const raw = localStorage.getItem(this._k(store));
    const obj = raw ? JSON.parse(raw) : {};
    obj[key] = value;
    localStorage.setItem(this._k(store), JSON.stringify(obj));
  },
  async del(store, key) {
    const raw = localStorage.getItem(this._k(store));
    if (!raw) return;
    const obj = JSON.parse(raw);
    delete obj[key];
    localStorage.setItem(this._k(store), JSON.stringify(obj));
  },
  async all(store) {
    const raw = localStorage.getItem(this._k(store));
    return raw ? Object.values(JSON.parse(raw)) : [];
  },
  async add(store, value) {
    const arr = await this.all(store);
    value.id = (arr.reduce((m, x) => Math.max(m, x.id || 0), 0) || 0) + 1;
    await this.set(store, value.id, value);
    return value.id;
  },
  async put(store, value) {
    if (value.id == null) return this.add(store, value);
    await this.set(store, value.id, value);
    return value.id;
  },
  async delete(store, id) { return this.del(store, id); },
  async clear(store) { localStorage.removeItem(this._k(store)); }
};

/* ---------- 统一 DB 门面 ---------- */
const DB = {
  _useLS: false,

  async _tx(store, mode) {
    if (this._useLS) return null;
    const db = await openDB();
    return db.transaction(store, mode).objectStore(store);
  },

  _promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async get(store, key) {
    try {
      if (this._useLS) return LSAdapter.get(store, key);
      return this._promisify((await this._tx(store, 'readonly')).get(key));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.get(store, key); }
      return undefined;
    }
  },

  async set(store, key, value) {
    try {
      if (this._useLS) return LSAdapter.set(store, key, value);
      return this._promisify((await this._tx(store, 'readwrite')).put(value, key));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.set(store, key, value); }
    }
  },

  async del(store, key) {
    try {
      if (this._useLS) return LSAdapter.del(store, key);
      return this._promisify((await this._tx(store, 'readwrite')).delete(key));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.del(store, key); }
    }
  },

  async all(store) {
    try {
      if (this._useLS) return LSAdapter.all(store);
      return this._promisify((await this._tx(store, 'readonly')).getAll());
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.all(store); }
      return [];
    }
  },

  async add(store, value) {
    try {
      if (this._useLS) return LSAdapter.add(store, value);
      return this._promisify((await this._tx(store, 'readwrite')).add(value));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.add(store, value); }
    }
  },

  async put(store, value) {
    try {
      if (this._useLS) return LSAdapter.put(store, value);
      return this._promisify((await this._tx(store, 'readwrite')).put(value));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.put(store, value); }
    }
  },

  async delete(store, id) {
    try {
      if (this._useLS) return LSAdapter.delete(store, id);
      return this._promisify((await this._tx(store, 'readwrite')).delete(id));
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.delete(store, id); }
    }
  },

  async clear(store) {
    try {
      if (this._useLS) return LSAdapter.clear(store);
      return this._promisify((await this._tx(store, 'readwrite')).clear());
    } catch (e) {
      if (!this._useLS) { this._useLS = true; return LSAdapter.clear(store); }
    }
  },

  /* ---------- 旧版 localStorage 数据迁移（一次性） ---------- */
  async migrateFromLocalStorage() {
    try {
      const hasNew = await this.get(PN_STORE.config, 'main');
      const oldCfg = JSON.parse(localStorage.getItem(PN_LS_KEYS.config) || 'null');
      if (!hasNew && oldCfg) await this.set(PN_STORE.config, 'main', oldCfg);

      const oldState = JSON.parse(localStorage.getItem(PN_LS_KEYS.progress) || 'null');
      if (oldState && oldState.novel) {
        await this.set(PN_STORE.novel, 'main', {
          title: oldState.novel.title,
          chapters: oldState.novel.chapters,
          fullText: oldState.novel.fullText
        });
        await this.set(PN_STORE.progress, 'main', {
          world: oldState.world,
          selectedRole: oldState.selectedRole,
          entryChapter: oldState.entryChapter,
          history: oldState.history || [],
          events: oldState.events || [],
          turn: oldState.turn || 0
        });
      }
    } catch (e) {
      console.warn('localStorage 迁移失败（可忽略）:', e.message);
    }
  },

  /* ---------- 估算存储占用（设置页展示） ---------- */
  async estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
    return { usage: 0, quota: 0 };
  }
};
