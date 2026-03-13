const DB_NAME = 'meshforum-db';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('threads')) {
        const threads = db.createObjectStore('threads', { keyPath: 'id' });
        threads.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('posts')) {
        const posts = db.createObjectStore('posts', { keyPath: 'id' });
        posts.createIndex('threadId', 'threadId');
        posts.createIndex('createdAt', 'createdAt');
        posts.createIndex('hash', 'hash', { unique: true });
      }

      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'hash' });
        messages.createIndex('threadId', 'threadId');
        messages.createIndex('expiresAt', 'expiresAt');
      }

      if (!db.objectStoreNames.contains('peers')) {
        db.createObjectStore('peers', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putRecord(db, storeName, value) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await txPromise(tx);
}

export async function getRecord(db, storeName, key) {
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).get(key);
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  return result;
}

export async function getAllRecords(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).getAll();
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  return result;
}

export async function getPostsByThread(db, threadId) {
  const tx = db.transaction('posts', 'readonly');
  const idx = tx.objectStore('posts').index('threadId');
  const req = idx.getAll(IDBKeyRange.only(threadId));
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
  await txPromise(tx);
  return result;
}

export async function hasMessageHash(db, hash) {
  const existing = await getRecord(db, 'messages', hash);
  return Boolean(existing);
}

export async function saveMessageEnvelope(db, envelope) {
  await putRecord(db, 'messages', envelope);
}

export async function pruneExpiredMessages(db, now = Date.now()) {
  const tx = db.transaction('messages', 'readwrite');
  const idx = tx.objectStore('messages').index('expiresAt');
  const range = IDBKeyRange.upperBound(now);
  const req = idx.openCursor(range);
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await txPromise(tx);
}
