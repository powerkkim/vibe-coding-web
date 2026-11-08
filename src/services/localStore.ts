/**
 * 브라우저 안 대화 저장소 (IndexedDB)
 *
 * 서버도 Google 드라이브도 쓸 수 없을 때(클라이언트 ID 미설정, 드라이브 미연결) 쓴다.
 * 이 브라우저에만 남고 다른 기기와는 공유되지 않는다. 이미지가 들어간 대화도 담을 수 있게 localStorage 대신 IndexedDB 를 쓴다.
 */

const DB_NAME = 'vibe-chats'
const STORE = 'chats'
// 최근 대화 비상 백업(드라이브와 별개로 항상 쓴다). v2 에서 추가.
const BACKUP = 'backup'

let dbPromise: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' })
      if (!d.objectStoreNames.contains(BACKUP)) d.createObjectStore(BACKUP, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { dbPromise = null; reject(req.error ?? new Error('브라우저 저장소를 열 수 없습니다')) }
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('브라우저 저장소 오류'))
  })
}

export const localGetAll = <T>() => run<T[]>('readonly', (s) => s.getAll() as IDBRequest<T[]>)
export const localGet = <T>(id: string) => run<T | undefined>('readonly', (s) => s.get(id) as IDBRequest<T | undefined>)
export const localPut = (value: { id: string }) => run('readwrite', (s) => s.put(value)).then(() => {})
export const localDelete = (id: string) => run('readwrite', (s) => s.delete(id)).then(() => {})

// ── 최근 대화 백업 ─────────────────────────────────────────
export const BACKUP_LIMIT = 10
export const backupGetAll = <T>() => run<T[]>('readonly', (s) => s.getAll() as IDBRequest<T[]>, BACKUP)
export const backupGet = <T>(id: string) => run<T | undefined>('readonly', (s) => s.get(id) as IDBRequest<T | undefined>, BACKUP)
export const backupDelete = (id: string) => run('readwrite', (s) => s.delete(id), BACKUP).then(() => {})
/** 백업에 넣고, 최근 수정 순으로 BACKUP_LIMIT 개만 남긴다. */
export async function backupPut(value: { id: string; updatedAt: number }) {
  await run('readwrite', (s) => s.put(value), BACKUP)
  const all = await backupGetAll<{ id: string; updatedAt: number }>()
  if (all.length <= BACKUP_LIMIT) return
  const old = all.sort((a, b) => b.updatedAt - a.updatedAt).slice(BACKUP_LIMIT)
  for (const o of old) await backupDelete(o.id)
}
