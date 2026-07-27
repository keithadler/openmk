// OpenMK — ROM loader (GPL-3.0)
// Fetches the SA-synthesis ROM images at runtime from the rdpiano repository
// (no ROM bytes ship with OpenMK), caches them in IndexedDB, and falls back
// to user-supplied files if the remote source is unavailable.

const ROM_BASE = 'https://raw.githubusercontent.com/giulioz/rdpiano/master/roms/';

// filename -> expected size
export const ROM_FILES = {
  'RD200_B.bin': 0x2000,
  'MK80_IC5.bin': 0x20000,
  'MK80_IC6.bin': 0x20000,
  'MK80_IC7.bin': 0x20000,
  'MK80_IC18.bin': 0x20000,
  'mks20_15179738.BIN': 0x20000,
  'mks20_15179737.BIN': 0x20000,
  'mks20_15179736.BIN': 0x20000,
  'mks20_15179741.BIN': 0x20000,
  'mks20_15179740.BIN': 0x20000,
  'mks20_15179739.BIN': 0x20000,
  'mks20_15179757.BIN': 0x20000,
};

const DB_NAME = 'openmk';
const STORE = 'roms';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Returns { roms: {filename: ArrayBuffer}, missing: [filename], fromCache: n }
export async function loadRoms(onProgress) {
  const db = await openDb().catch(() => null);
  const roms = {};
  const missing = [];
  let fromCache = 0;
  const names = Object.keys(ROM_FILES);

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    onProgress?.(name, i, names.length);

    let data = db ? await dbGet(db, name).catch(() => null) : null;
    if (data && data.byteLength >= ROM_FILES[name]) {
      roms[name] = data;
      fromCache++;
      continue;
    }

    try {
      const resp = await fetch(ROM_BASE + name);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.arrayBuffer();
      if (data.byteLength < ROM_FILES[name]) throw new Error('short file');
      roms[name] = data;
      if (db) await dbPut(db, name, data).catch(() => {});
    } catch (err) {
      missing.push(name);
    }
  }

  return { roms, missing, fromCache };
}

// Accepts user-supplied File objects (drop zone fallback); stores valid ones.
export async function importRomFiles(files) {
  const db = await openDb().catch(() => null);
  const imported = [];
  for (const file of files) {
    const expected = ROM_FILES[file.name];
    if (!expected) continue;
    const data = await file.arrayBuffer();
    if (data.byteLength < expected) continue;
    if (db) await dbPut(db, file.name, data).catch(() => {});
    imported.push(file.name);
  }
  return imported;
}

// Groups raw buffers into the structure the worklet expects.
export function groupRoms(roms) {
  return {
    prog: roms['RD200_B.bin'],
    mks20a: {
      ic5: roms['mks20_15179738.BIN'],
      ic6: roms['mks20_15179737.BIN'],
      ic7: roms['mks20_15179736.BIN'],
      ic18: roms['mks20_15179757.BIN'],
    },
    mks20b: {
      ic5: roms['mks20_15179741.BIN'],
      ic6: roms['mks20_15179740.BIN'],
      ic7: roms['mks20_15179739.BIN'],
      ic18: roms['mks20_15179757.BIN'],
    },
    mk80: {
      ic5: roms['MK80_IC5.bin'],
      ic6: roms['MK80_IC6.bin'],
      ic7: roms['MK80_IC7.bin'],
      ic18: roms['MK80_IC18.bin'],
    },
  };
}
