const DB = "attendance-pwa", STORE = "kv", KEY = "installation-id";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Random per-browser-installation UUID kept in IndexedDB. It is a RISK SIGNAL only:
 * it can be cleared, copied or recreated and is not hardware-backed proof of a device.
 */
async function requestPersistentStorage(): Promise<void> {
  try {
    // Best effort: supported browsers may protect this origin's IndexedDB from routine eviction.
    // This is not a hardware identity and does not prevent the user from clearing site data.
    const storage = navigator.storage;
    if (storage?.persisted && storage?.persist) {
      if (!(await storage.persisted())) await storage.persist();
    }
  } catch { /* persistence is an optional browser capability */ }
}

export async function getInstallationId(): Promise<string> {
  try {
    await requestPersistentStorage();
    const db = await open();
    const existing = await new Promise<string | undefined>((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(fresh, KEY);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
    return fresh;
  } catch {
    const fallback = localStorage.getItem(KEY) ?? crypto.randomUUID();
    localStorage.setItem(KEY, fallback);
    return fallback;
  }
}
