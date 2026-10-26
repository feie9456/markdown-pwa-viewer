export type StoredDocument = {
  id: string
  name: string
  source: string
  size: number
  lastModified: number
  lastOpenedAt: number
  handle?: FileSystemFileHandle
  directoryHandle?: FileSystemDirectoryHandle
}

export type StoredSession = {
  key: 'session'
  openIds: string[]
  activeId: string | null
  scrollById: Record<string, number>
}

export type StoredDirectories = {
  key: 'directories'
  handles: FileSystemDirectoryHandle[]
}

const DB_NAME = 'markdown-pwa-viewer'
const DB_VERSION = 1
const DOCUMENTS_STORE = 'documents'
const SESSION_STORE = 'session'

let dbPromise: Promise<IDBDatabase> | null = null

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'))
  })

  return dbPromise
}

async function putDocumentOnce(document: StoredDocument): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(DOCUMENTS_STORE, 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(DOCUMENTS_STORE).put(document)
  await done
}

export async function putDocument(document: StoredDocument): Promise<void> {
  try {
    await putDocumentOnce(document)
  } catch (error) {
    if (!document.handle && !document.directoryHandle) throw error

    // FileSystemHandle is structured-cloneable in Chromium, but not all browsers
    // support persisting it in IndexedDB. Keep the content snapshot as a fallback.
    const { handle: _handle, directoryHandle: _directoryHandle, ...snapshotOnly } = document
    await putDocumentOnce(snapshotOnly)
  }
}

export async function getDocuments(ids: string[]): Promise<StoredDocument[]> {
  if (!ids.length) return [] as StoredDocument[]

  const db = await openDatabase()
  const transaction = db.transaction(DOCUMENTS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const store = transaction.objectStore(DOCUMENTS_STORE)
  const documents = await Promise.all(ids.map((id) => requestToPromise(store.get(id))))
  await done

  return documents.filter((document): document is StoredDocument => Boolean(document))
}

export async function getRecentDocuments(limit = 20): Promise<StoredDocument[]> {
  const db = await openDatabase()
  const transaction = db.transaction(DOCUMENTS_STORE, 'readonly')
  const done = transactionDone(transaction)
  const documents = await requestToPromise(transaction.objectStore(DOCUMENTS_STORE).getAll()) as StoredDocument[]
  await done

  return documents
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, limit)
}

export async function getSession(): Promise<StoredSession | null> {
  const db = await openDatabase()
  const transaction = db.transaction(SESSION_STORE, 'readonly')
  const done = transactionDone(transaction)
  const session = await requestToPromise(transaction.objectStore(SESSION_STORE).get('session')) as StoredSession | undefined
  await done
  return session ?? null
}

export async function putSession(session: StoredSession): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(SESSION_STORE, 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(SESSION_STORE).put(session)
  await done
}

export async function getDirectoryHandles(): Promise<FileSystemDirectoryHandle[]> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(SESSION_STORE, 'readonly')
    const done = transactionDone(transaction)
    const record = await requestToPromise(transaction.objectStore(SESSION_STORE).get('directories')) as StoredDirectories | undefined
    await done
    return Array.isArray(record?.handles) ? record.handles : []
  } catch {
    return []
  }
}

export async function putDirectoryHandles(handles: FileSystemDirectoryHandle[]): Promise<void> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(SESSION_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const record: StoredDirectories = {
      key: 'directories',
      handles,
    }
    transaction.objectStore(SESSION_STORE).put(record)
    await done
  } catch {
    // Ignore if browser does not support persisting FileSystemDirectoryHandle in IndexedDB.
  }
}
