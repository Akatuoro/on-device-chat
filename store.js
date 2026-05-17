const DB_NAME = "sessions";
const DB_VERSION = 2;
const STORE_NAME = "messages";

const store = {
  async open() {
    this.db = await openDB()
  },
  async save(type, content) {
    await this.open()
    return await save(this.db, type, content)
  },
  async saveSession(content) {
    return await this.save("sessions", content)
  },
  async saveMessage(content) {
    return await this.save("messages", content)
  },
  async getAll(type, filter) {
    await this.open()
    const [idx, id] = Object.entries(filter)[0]
    return await getAll(this.db, type, idx, id)
  },
  async getSessions() {
    return await this.getAll("sessions", {id: undefined})
  },
  async getMessages(sessionId) {
    return await this.getAll("messages", { sessionId })
  },

  async sessionCursor(id, cb) {
    await this.open()
    return withCursor(this.db, "sessions", "id", id, cb)
  },
  async messageCursor(sessionId, cb) {
    return withCursor(this.db, "messages", "sessionId", sessionId, cb)
  },
  async deleteSession(id) {
    await this.messageCursor(id, cursor => cursor.delete())
    await this.sessionCursor(id, cursor => cursor.delete())
  },
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", {
          keyPath: "id",
          autoIncrement: true
        });

        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", {
          keyPath: "id",
          autoIncrement: true
        })

        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = () => reject(request.error);
  });
}

function save(db, storeName, content) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    content.createdAt ??= new Date().toISOString();
    content.updatedAt = new Date().toISOString();

    const request = store.put(content);
    request.onsuccess = () => {
      resolve({
        ...content,
        id: request.result
      });
    };
    request.onerror = () => reject(request.error);
  });
}

function getAll(db, storeName, indexName, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);

    const index = indexName === store.keyPath ? store : store.index(indexName);

    const request = index.getAll(id);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);

  });
}

function withCursor(db, storeName, indexName, id, cb) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const index = indexName === store.keyPath ? store : store.index(indexName);

    const request = index.openCursor(IDBKeyRange.only(id));

    request.onsuccess = (event) => {
      const cursor = event.target.result;

      if (cursor) {
        cb(cursor)
        cursor.continue();
      } else {
        resolve();
      }
    };

    request.onerror = () => reject(request.error);
  });
}

window.store = store;
