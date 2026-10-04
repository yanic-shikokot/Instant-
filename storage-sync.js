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
      if (photo.storagePath && urls.get(photo.storagePath)) photo.data = urls.get(photo.storagePath);
    }
  }
  for (const attachment of (state.attachments || [])) {
    if (attachment.storagePath && urls.get(attachment.storagePath)) attachment.data = urls.get(attachment.storagePath);
  }
  return state;
}

async function ensureStored(state) {
  if (!client() || !user()) return state;
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
  if (!client() || !user()) return state;
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

window.FIELDINSPECT_STORAGE = {
  BUCKET,
  uploadPhoto,
  uploadAttachment,
  hydrate,
  ensureStored,
  cloneEvidence,
  deleteInspectionEvidence,
  deleteObjects,
  photoDataUrls
};
