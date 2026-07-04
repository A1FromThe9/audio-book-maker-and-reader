// IndexedDB persistence: book metadata, extracted text, and original PDF blobs.

const DB_NAME = 'audiobook-reader';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqp(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function addBook(meta, paragraphs, pdfBlob) {
  const d = await db();
  const t = d.transaction(['books', 'texts', 'files'], 'readwrite');
  t.objectStore('books').put(meta);
  t.objectStore('texts').put(paragraphs, meta.id);
  if (pdfBlob) t.objectStore('files').put(pdfBlob, meta.id);
  return done(t);
}

export async function listBooks() {
  const d = await db();
  const all = await reqp(d.transaction('books').objectStore('books').getAll());
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getBook(id) {
  const d = await db();
  return reqp(d.transaction('books').objectStore('books').get(id));
}

export async function getText(id) {
  const d = await db();
  return reqp(d.transaction('texts').objectStore('texts').get(id));
}

export async function deleteBook(id) {
  const d = await db();
  const t = d.transaction(['books', 'texts', 'files'], 'readwrite');
  t.objectStore('books').delete(id);
  t.objectStore('texts').delete(id);
  t.objectStore('files').delete(id);
  return done(t);
}

export async function saveProgress(id, sentenceIndex) {
  const d = await db();
  const t = d.transaction('books', 'readwrite');
  const s = t.objectStore('books');
  const book = await reqp(s.get(id));
  if (!book) return;
  book.progress = { sentenceIndex, updatedAt: Date.now() };
  s.put(book);
  return done(t);
}
