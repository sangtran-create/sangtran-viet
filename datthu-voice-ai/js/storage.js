// Lưu bản ghi trong IndexedDB của máy để không mất khi mất mạng, hết phiên đăng nhập hay app bị đóng.
// recordings: thông tin từng bản ghi · chunks: các đoạn âm thanh 10 giây, khóa [recId, seq].

const DB_NAME = 'datthu-voice-ai';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) {
          const s = db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
          s.createIndex('byRec', 'recId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('Bộ nhớ máy đang bị khóa bởi một cửa sổ khác của ứng dụng.')); };
    });
  }
  return dbPromise;
}

function asPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function completion(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Ghi bộ nhớ máy bị hủy (có thể máy hết dung lượng).'));
  });
}

const chunkRange = (recId) => IDBKeyRange.bound([recId, 0], [recId, Infinity]);

export async function putRecording(rec) {
  const db = await openDb();
  const t = db.transaction('recordings', 'readwrite');
  t.objectStore('recordings').put({ ...rec, updatedAt: Date.now() });
  await completion(t);
}

export async function getRecording(id) {
  const db = await openDb();
  return asPromise(db.transaction('recordings').objectStore('recordings').get(id));
}

export async function listRecordings() {
  const db = await openDb();
  const all = await asPromise(db.transaction('recordings').objectStore('recordings').getAll());
  return all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function addChunk(recId, seq, blob) {
  const db = await openDb();
  const t = db.transaction('chunks', 'readwrite');
  t.objectStore('chunks').put({ recId, seq, blob });
  await completion(t);
}

export async function getChunkBlobs(recId) {
  const db = await openDb();
  const rows = await asPromise(db.transaction('chunks').objectStore('chunks').getAll(chunkRange(recId)));
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map((r) => r.blob);
}

export async function deleteChunks(recId) {
  const db = await openDb();
  const t = db.transaction('chunks', 'readwrite');
  t.objectStore('chunks').delete(chunkRange(recId));
  await completion(t);
}

export async function deleteRecording(recId) {
  const db = await openDb();
  const t = db.transaction(['recordings', 'chunks'], 'readwrite');
  t.objectStore('chunks').delete(chunkRange(recId));
  t.objectStore('recordings').delete(recId);
  await completion(t);
}

// Xin trình duyệt không tự xóa dữ liệu khi máy thiếu bộ nhớ.
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* không bắt buộc */ }
}
