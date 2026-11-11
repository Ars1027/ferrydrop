export async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("ferrydrop", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("data");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function get<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("data").objectStore("data").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function put(key: string, value: unknown) {
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction("data", "readwrite");
    t.objectStore("data").put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export interface Identity {
  deviceId: string;
  privateKey: CryptoKey;
}
