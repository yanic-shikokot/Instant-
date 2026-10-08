import { createClient } from '@supabase/supabase-js';

const BUCKET = 'fieldinspect-evidence';
const SIGNED_URL_TTL = 3600;

function client() {
  return window.FIELDINSPECT_SUPABASE || null;
}

function user() {
  return window.FIELDINSPECT_AUTH_USER || null;
}

function requireUser() {
  const u = user();
  if (!u?.id) throw new Error('Sign in to store inspection evidence in the cloud.');
  if (!client()) throw new Error('Supabase storage is not configured.');
  return u;
}

function ext(name, fallback='bin') {
  const value = String(name || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g,'');
  return value || fallback;
}

function storageKey(state) {
  return String(state?.meta?.storageId || state?.meta?.reportId || '').trim();
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) throw new Error('Unsupported evidence data.');
  const mime = match[1] || 'application/octet-stream';
  const raw = match[2] || '';
  if (String(dataUrl).includes(';base64,')) {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(raw)], { type: mime });
}

function fileToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function safePath(state, prefix, id, extension) {
  const u = requireUser();
  const key = storageKey(state);
  if (!key) throw new Error('Inspection storage ID is missing.');
  return u.id + '/' + key + '/' + prefix + '-' + id + '.' + extension;
}

async function uploadBlob(path, blob, contentType) {
  const { error } = await client().storage.from(BUCKET).upload(path, blob, {
    cacheControl: '3600',
    contentType: contentType || blob.type || 'application/octet-stream',
    upsert: false
  });
  if (error) {
    if (/already exists|Duplicate/i.test(error.message || '')) {
      const { error: replaceError } = await client().storage.from(BUCKET).update(path, blob, {
        cacheControl: '3600',
        contentType: contentType || blob.type || 'application/octet-stream',
        upsert: true
      });
      if (replaceError) throw replaceError;
    } else {
      throw error;
    }
  }
  return path;
}

async function uploadDataUrl(state, prefix, id, dataUrl, name, contentType, extension) {
  requireUser();
  const path = safePath(state, prefix, id, extension || ext(name, 'bin'));
  const blob = dataUrlToBlob(dataUrl);
  await uploadBlob(path, blob, contentType);
  return path;
}

async function uploadPhoto(state, photo) {
  const path = await uploadDataUrl(
    state,
    'photo',
    photo.id,
    photo.data,
    photo.name,
    'image/jpeg',
    'jpg'
  );
  photo.storagePath = path;
  photo.data = photo.data || '';
  photo.size = dataUrlToBlob(photo.data).size;
  return photo;
}

async function uploadAttachment(state, attachment) {
  const path = safePath(state, 'doc', attachment.id, ext(attachment.name, 'bin'));
  let blob;
  if (attachment.file instanceof File) {
    blob = attachment.file;
  } else if (attachment.data) {
    blob = dataUrlToBlob(attachment.data);
  } else {
    throw new Error('Attachment data is missing.');
  }
  await uploadBlob(path, blob, attachment.type || blob.type);
  attachment.storagePath = path;
  attachment.file = undefined;
  attachment.data = attachment.data || '';
  return attachment;
}

async function signPaths(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length || !client() || !user()) return new Map();
  const { data, error } = await client().storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_TTL);
  if (error) throw error;
  return new Map((data || []).map(row => [row.path, row.signedUrl]));
}

async function hydrate(state) {
  if (!client() || !user()) return state;
  const paths = [];
  for (const item of (state.items || [])) {
    for (const photo of (item.photos || [])) if (photo.storagePath) paths.push(photo.storagePath);
  }
  for (const attachment of (state.attachments || [])) if (attachment.storagePath) paths.push(attachment.storagePath);
  const urls = await signPaths(paths);
  for (const item of (state.items || [])) {
    for (const photo of (item.photos || [])) {
      if (photo.storagePath && !String(photo.data || '').startsWith('data:') && urls.get(photo.storagePath)) {
        photo.data = urls.get(photo.storagePath);
      }
    }
  }
  for (const attachment of (state.attachments || [])) {
    if (attachment.storagePath && urls.get(attachment.storagePath)) attachment.data = urls.get(attachment.storagePath);
  }
  return state;
}

async function ensureStored(state) {
  if (!client() || !user() || typeof navigator !== 'undefined' && !navigator.onLine) return state;
  if (!storageKey(state)) state.meta.storageId = state.meta.reportId || ('INS-' + crypto.randomUUID());

  for (const item of (state.items || [])) {
    for (const photo of (item.photos || [])) {
      if (!photo.id) photo.id = 'PHOTO-' + crypto.randomUUID();
      if (!photo.storagePath && photo.data) {
        await uploadPhoto(state, photo);
      }
    }
  }
  for (const attachment of (state.attachments || [])) {
    if (!attachment.id) attachment.id = 'DOC-' + crypto.randomUUID();
    if (!attachment.storagePath && (attachment.data || attachment.file)) {
      await uploadAttachment(state, attachment);
    }
  }
  return state;
}

async function cloneEvidence(sourceState, targetState) {
  if (!client() || !user()) return targetState;
  if (!storageKey(targetState)) targetState.meta.storageId = targetState.meta.reportId || ('INS-' + crypto.randomUUID());
  const u = requireUser();
  const sourceKey = storageKey(sourceState);
  const targetKey = storageKey(targetState);
  if (!sourceKey || !targetKey) return targetState;

  for (const item of (targetState.items || [])) {
    const sourceItem = (sourceState.items || []).find(x => x.id === item.id);
    for (const photo of (item.photos || [])) {
      const sourcePhoto = (sourceItem?.photos || []).find(x => x.id === photo.id);
      if (!sourcePhoto) continue;
      if (sourcePhoto.storagePath) {
        try {
          const { data: blob, error } = await client().storage.from(BUCKET).download(sourcePhoto.storagePath);
          if (error) throw error;
          const newPath = u.id + '/' + targetKey + '/photo-' + photo.id + '.jpg';
          await uploadBlob(newPath, blob, 'image/jpeg');
          photo.storagePath = newPath;
        } catch (err) {
          console.warn('FieldInspect: could not clone photo from cloud storage:', sourcePhoto.storagePath, err);
        }
      } else if (sourcePhoto.data) {
        try {
          await uploadPhoto(targetState, photo);
        } catch (err) {
          console.warn('FieldInspect: could not re-upload photo data during clone:', err);
        }
      }
      photo.data = sourcePhoto.data || photo.data || '';
    }
  }

  for (const attachment of (targetState.attachments || [])) {
    const sourceAttachment = (sourceState.attachments || []).find(x => x.id === attachment.id);
    if (!sourceAttachment) continue;
    if (sourceAttachment.storagePath) {
      try {
        const { data: blob, error } = await client().storage.from(BUCKET).download(sourceAttachment.storagePath);
        if (error) throw error;
        const newPath = u.id + '/' + targetKey + '/doc-' + attachment.id + '.' + ext(attachment.name, 'bin');
        await uploadBlob(newPath, blob, attachment.type);
        attachment.storagePath = newPath;
      } catch (err) {
        console.warn('FieldInspect: could not clone attachment from cloud storage:', sourceAttachment.storagePath, err);
      }
    } else if (sourceAttachment.data) {
      try {
        await uploadAttachment(targetState, attachment);
      } catch (err) {
        console.warn('FieldInspect: could not re-upload attachment data during clone:', err);
      }
    }
    attachment.data = sourceAttachment.data || attachment.data || '';
  }
  return targetState;
}

async function deleteObjects(paths) {
  const clean=[...new Set((paths||[]).filter(Boolean))];
  if(!clean.length||!client()||!user())return;
  const {error}=await client().storage.from(BUCKET).remove(clean);
  if(error)throw error;
}

async function deleteInspectionEvidence(stateOrStorageId) {
  if (!client() || !user()) return;
  const u = requireUser();
  const key = typeof stateOrStorageId === 'string' ? stateOrStorageId : storageKey(stateOrStorageId);
  if (!key) return;
  const folder = u.id + '/' + key;
  const { data, error } = await client().storage.from(BUCKET).list(folder, { limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  const paths = (data || []).filter(x => x?.name).map(x => folder + '/' + x.name);
  if (!paths.length) return;
  const { error: removeError } = await client().storage.from(BUCKET).remove(paths);
  if (removeError) throw removeError;
}

async function photoDataUrls(state) {
  if (!client() || !user() || typeof navigator !== 'undefined' && !navigator.onLine) return state;
  for (const item of (state.items || [])) {
    for (const photo of (item.photos || [])) {
      if (!photo.data && photo.storagePath) {
        try {
          const { data: blob, error } = await client().storage.from(BUCKET).download(photo.storagePath);
          if (error) throw error;
          photo.data = await fileToDataUrl(blob);
        } catch (err) {
          console.warn('FieldInspect: could not load photo data URL for PDF generation:', photo.storagePath, err);
        }
      }
    }
  }
  return state;
}

// ==========================================
// IndexedDB Local Storage Fallback Engine
// ==========================================
const DB_NAME = 'fieldinspect_pro_db';
const DB_VERSION = 2;
const STORE_ACTIVE = 'active_state';
const STORE_INSPECTIONS = 'inspections_backup';
const STORE_HISTORY_PRIMARY = 'history_primary';
const STORE_TRASH_PRIMARY = 'trash_primary';

let localScope = 'anonymous';
let primaryHistory = [];
let primaryTrash = [];
let localStoreReady = null;
let primaryWriteQueue = Promise.resolve();

let idbInstance = null;

function openDB() {
  if (idbInstance) return Promise.resolve(idbInstance);
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not supported in this browser.'));
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ACTIVE)) {
        db.createObjectStore(STORE_ACTIVE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_INSPECTIONS)) {
        db.createObjectStore(STORE_INSPECTIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY_PRIMARY)) {
        db.createObjectStore(STORE_HISTORY_PRIMARY, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_TRASH_PRIMARY)) {
        db.createObjectStore(STORE_TRASH_PRIMARY, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY_PRIMARY)) {
        db.createObjectStore(STORE_HISTORY_PRIMARY, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_TRASH_PRIMARY)) {
        db.createObjectStore(STORE_TRASH_PRIMARY, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      idbInstance = req.result;
      idbInstance.onversionchange = () => {
        try { idbInstance.close(); } catch (_) {}
        idbInstance = null;
      };
      resolve(idbInstance);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another open FieldInspect window.'));
  });
}

async function idbPut(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

function normalizeScope(scope) {
  const value = String(scope || 'anonymous').trim();
  return value || 'anonymous';
}
function scopedKey(id, scope=localScope) {
  return normalizeScope(scope) + ':' + String(id);
}
function legacyHistoryKey(scope=localScope) {
  return 'fieldinspect-pro-v2:history:' + normalizeScope(scope);
}
function legacyTrashKey(scope=localScope) {
  return 'fieldinspect-pro-v2:trash:' + normalizeScope(scope);
}
function cloneJson(value, fallback=null) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return fallback; }
}
function sortHistory(list) {
  return (Array.isArray(list)?list:[]).slice(0,100).sort((a,b)=>(Date.parse(b?.updatedAt||0)||0)-(Date.parse(a?.updatedAt||0)||0));
}
async function readScopedStore(storeName, scope) {
  const rows=await idbGetAll(storeName);
  return rows.filter(r=>r?.scope===scope).map(r=>cloneJson(r.value)).filter(Boolean);
}
async function writeScopedStore(storeName, scope, values) {
  const db=await openDB();
  const clean=(Array.isArray(values)?values:[]).slice(0,100);
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readwrite');
    const store=tx.objectStore(storeName);
    const existing=[];
    const cursor=store.openCursor();
    cursor.onsuccess=()=>{
      const c=cursor.result;
      if(!c){
        existing.forEach(r=>store.delete(r.key));
        clean.forEach(value=>{
          const id=String(value?.id||value?.reportId||crypto.randomUUID());
          store.put({key:scopedKey(id,scope),scope,value:cloneJson(value,{})});
        });
        return;
      }
      if(c.value?.scope===scope)existing.push(c.value);
      c.continue();
    };
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error||new Error('IndexedDB transaction aborted.'));
  });
}
function mirrorLocal(key,value) {
  try { localStorage.setItem(key,JSON.stringify((Array.isArray(value)?value:[]).slice(0,100))); }
  catch (error) { console.warn('FieldInspect localStorage mirror unavailable:',error); }
}
function persistPrimaryCollections() {
  const scope=localScope;
  const history=cloneJson(primaryHistory,[]);
  const trash=cloneJson(primaryTrash,[]);
  primaryWriteQueue=primaryWriteQueue.then(async()=>{
    await writeScopedStore(STORE_HISTORY_PRIMARY,scope,history);
    await writeScopedStore(STORE_TRASH_PRIMARY,scope,trash);
  }).catch(error=>console.error('FieldInspect IndexedDB primary history persistence failed:',error));
  return primaryWriteQueue;
}
async function initializeLocalStore(scope='anonymous') {
  localScope=normalizeScope(scope);
  if(localStoreReady)return localStoreReady;
  localStoreReady=(async()=>{
    await openDB();
    let history=await readScopedStore(STORE_HISTORY_PRIMARY,localScope);
    let trash=await readScopedStore(STORE_TRASH_PRIMARY,localScope);
    if(!history.length){
      try { const legacy=JSON.parse(localStorage.getItem(legacyHistoryKey())||'[]'); if(Array.isArray(legacy))history=legacy; } catch (_) {}
    }
    if(!trash.length){
      try { const legacy=JSON.parse(localStorage.getItem(legacyTrashKey())||'[]'); if(Array.isArray(legacy))trash=legacy; } catch (_) {}
    }
    primaryHistory=sortHistory(history);
    primaryTrash=(Array.isArray(trash)?trash:[]).slice(0,100);
    mirrorLocal(legacyHistoryKey(),primaryHistory);
    mirrorLocal(legacyTrashKey(),primaryTrash);
    if(history.length || trash.length)await persistPrimaryCollections();
  })().catch(error=>{
    console.error('FieldInspect local store initialization failed:',error);
    primaryHistory=[];primaryTrash=[];
  });
  return localStoreReady;
}
async function switchLocalScope(scope='anonymous') {
  const next=normalizeScope(scope);
  if(next===localScope && localStoreReady)return localStoreReady;
  const previous=localScope;
  const anonymousHistory=primaryHistory.slice();
  const anonymousTrash=primaryTrash.slice();
  localScope=next;
  localStoreReady=null;
  await initializeLocalStore(next);
  if(previous==='anonymous' && next!=='anonymous'){
    const merge=(current,old)=>{
      const out=current.slice(),seen=new Set(out.map(x=>x?.id||x?.reportId).filter(Boolean));
      old.forEach(x=>{const k=x?.id||x?.reportId;if(k&&!seen.has(k)){out.push(x);seen.add(k)}});
      return out;
    };
    if(anonymousHistory.length)setHistorySync(merge(primaryHistory,anonymousHistory));
    if(anonymousTrash.length)setTrashSync(merge(primaryTrash,anonymousTrash));
  }
  return localStoreReady;
}
function getHistorySync(){return primaryHistory.slice();}
function getTrashSync(){return primaryTrash.slice();}
function setHistorySync(list){primaryHistory=sortHistory(list);mirrorLocal(legacyHistoryKey(),primaryHistory);void persistPrimaryCollections();return true;}
function setTrashSync(list){primaryTrash=(Array.isArray(list)?list:[]).slice(0,100);mirrorLocal(legacyTrashKey(),primaryTrash);void persistPrimaryCollections();return true;}
async function saveActiveState(state) {
  if (!state) return false;
  try {
    const data = JSON.parse(JSON.stringify(state));
    await idbPut(STORE_ACTIVE, {
      key: scopedKey('current_draft'),
      scope: localScope,
      updatedAt: new Date().toISOString(),
      state: data
    });
    return true;
  } catch (err) {
    console.error('FieldInspect IndexedDB saveActiveState error:', err);
    return false;
  }
}

async function loadActiveState() {
  try {
    await initializeLocalStore(localScope);
    const record = await idbGet(STORE_ACTIVE, scopedKey('current_draft'));
    return record?.state || null;
  } catch (err) {
    console.error('FieldInspect IndexedDB loadActiveState error:', err);
    return null;
  }
}

async function saveInspectionBackup(id, record) {
  if (!id || !record) return false;
  try {
    await initializeLocalStore(localScope);
    const next=primaryHistory.slice();
    const index=next.findIndex(item=>item?.id===id||item?.reportId===record?.reportId);
    const value=cloneJson(record,null);
    if(!value)return false;
    if(index>=0)next[index]=value;else next.unshift(value);
    return setHistorySync(next);
  } catch (err) {
    console.error('FieldInspect IndexedDB saveInspectionBackup error:', err);
    return false;
  }
}

async function loadInspectionBackup(id) {
  try {
    await initializeLocalStore(localScope);
    return primaryHistory.find(item=>item?.id===id||item?.reportId===id)||null;
  } catch (err) {
    console.error('FieldInspect IndexedDB loadInspectionBackup error:', err);
    return null;
  }
}

async function getAllInspectionBackups() {
  try {
    await initializeLocalStore(localScope);
    return primaryHistory.slice();
  } catch (err) {
    console.error('FieldInspect IndexedDB getAllInspectionBackups error:', err);
    return [];
  }
}

async function deleteInspectionBackup(id) {
  try {
    await initializeLocalStore(localScope);
    setHistorySync(primaryHistory.filter(item=>item?.id!==id&&item?.reportId!==id));
    return true;
  } catch (err) {
    console.error('FieldInspect IndexedDB deleteInspectionBackup error:', err);
    return false;
  }
}

window.FIELDINSPECT_STORAGE = {
  BUCKET,
  initializeLocalStore,
  switchLocalScope,
  getHistorySync,
  setHistorySync,
  getTrashSync,
  setTrashSync,
  whenReady: () => localStoreReady || initializeLocalStore(localScope),
  uploadPhoto,
  uploadAttachment,
  hydrate,
  ensureStored,
  cloneEvidence,
  deleteInspectionEvidence,
  deleteObjects,
  photoDataUrls,
  // IndexedDB offline persistent backup APIs:
  saveActiveState,
  loadActiveState,
  saveInspectionBackup,
  loadInspectionBackup,
  getAllInspectionBackups,
  deleteInspectionBackup,
  openDB
};
