// Google Drive API v3 gọi thẳng từ trình duyệt: tìm/tạo thư mục, tải file kiểu resumable có thanh tiến trình.
import { DRIVE_FOLDER_NAME, UPLOAD_CHUNK_BYTES } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_KEY = 'dtvoice.folderId.v1';
const MAX_RETRIES = 6;

export class DriveAuthError extends Error {
  constructor(message) { super(message); this.name = 'DriveAuthError'; }
}

export class OfflineError extends Error {
  constructor(message) { super(message); this.name = 'OfflineError'; }
}

export class DriveError extends Error {
  constructor(message, { status = 0, reason = '', retryable = false } = {}) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function offline() {
  return new OfflineError('Thiết bị đang mất mạng.');
}

function networkError() {
  return navigator.onLine
    ? new DriveError('Mạng chập chờn, đang thử lại.', { retryable: true })
    : offline();
}

function parseReason(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error || {};
    return { reason: (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '', message: e.message || '' };
  } catch {
    return { reason: '', message: '' };
  }
}

function toDriveError(status, text) {
  const { reason, message } = parseReason(text);
  if (status === 401) return new DriveAuthError('Phiên đăng nhập Google đã hết hạn.');
  if (status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(reason)) {
    return new DriveError('Google Drive đã hết dung lượng. Dọn bớt Drive rồi bấm tải lại.', { status, reason });
  }
  if (status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
    return new DriveError('Google Drive đang giới hạn tần suất, đang thử lại.', { status, reason, retryable: true });
  }
  if (status === 403 && /insufficient|PERMISSION_DENIED/i.test(reason)) {
    return new DriveAuthError('Chưa cấp đủ quyền Google Drive. Kết nối lại và tích ô quyền Drive.');
  }
  if (status === 429 || status >= 500) {
    return new DriveError(`Máy chủ Google Drive bận (${status}), đang thử lại.`, { status, reason, retryable: true });
  }
  return new DriveError(`Google Drive báo lỗi ${status}${message ? `: ${message}` : ''}.`, { status, reason });
}

async function api(token, path, { method = 'GET', query, body } = {}) {
  if (!navigator.onLine) throw offline();
  const url = new URL(API + path);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json; charset=UTF-8';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw networkError();
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  throw toDriveError(res.status, await res.text().catch(() => ''));
}

export async function getAccount(token) {
  const about = await api(token, '/about', { query: { fields: 'user(displayName,emailAddress)' } });
  return (about && about.user) || {};
}

// Tìm thư mục DatThu_Meeting_Records do app tạo; chưa có thì tạo mới ở thư mục gốc "Drive của tôi".
export async function ensureFolder(token) {
  const cached = localStorage.getItem(FOLDER_KEY);
  if (cached) {
    try {
      const f = await api(token, `/files/${encodeURIComponent(cached)}`, { query: { fields: 'id,trashed' } });
      if (f && !f.trashed) return cached;
    } catch (e) {
      if (!(e instanceof DriveError && e.status === 404)) throw e;
    }
    localStorage.removeItem(FOLDER_KEY);
  }
  const q = `name = '${DRIVE_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const list = await api(token, '/files', {
    query: { q, spaces: 'drive', fields: 'files(id,name)', orderBy: 'createdTime', pageSize: '10' },
  });
  let id = list && list.files && list.files[0] && list.files[0].id;
  if (!id) {
    const created = await api(token, '/files', {
      method: 'POST',
      query: { fields: 'id' },
      body: { name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME },
    });
    id = created.id;
  }
  localStorage.setItem(FOLDER_KEY, id);
  return id;
}

function parseRange(header) {
  const m = /bytes=0-(\d+)/.exec(header || '');
  return m ? Number(m[1]) + 1 : null;
}

function xhrRequest({ method, url, headers, body, onUploadProgress, timeout = 180000 }) {
  return new Promise((resolve, reject) => {
    if (!navigator.onLine) { reject(offline()); return; }
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onUploadProgress(e.loaded); };
    }
    xhr.timeout = timeout;
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(networkError());
    xhr.ontimeout = () => reject(networkError());
    xhr.send(body === undefined ? null : body);
  });
}

async function createSession({ token, name, mimeType, folderId, total }) {
  if (!navigator.onLine) throw offline();
  let res;
  try {
    res = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,name,size`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify({ name, mimeType, parents: [folderId], description: 'Ghi âm cuộc họp bằng Đất Thủ Voice AI' }),
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw toDriveError(res.status, await res.text().catch(() => ''));
  return res.headers.get('Location');
}

// Hỏi máy chủ đã nhận đến byte nào. Trả { done, file } hoặc { offset }.
async function queryStatus(uri, token, total, fallbackOffset) {
  const xhr = await xhrRequest({
    method: 'PUT',
    url: uri,
    headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${total}` },
  });
  if (xhr.status === 200 || xhr.status === 201) return { done: true, file: safeJson(xhr.responseText) };
  if (xhr.status === 308) {
    const next = parseRange(xhr.getResponseHeader('Range'));
    return { done: false, offset: next !== null ? next : fallbackOffset };
  }
  throw toDriveError(xhr.status, xhr.responseText);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function putChunk({ uri, token, blob, start, end, total, onLoaded }) {
  const xhr = await xhrRequest({
    method: 'PUT',
    url: uri,
    headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
    body: blob.slice(start, end),
    onUploadProgress: onLoaded,
  });
  if (xhr.status === 200 || xhr.status === 201) return { done: true, file: safeJson(xhr.responseText) };
  if (xhr.status === 308) {
    const next = parseRange(xhr.getResponseHeader('Range'));
    return { done: false, offset: next !== null ? next : end };
  }
  throw toDriveError(xhr.status, xhr.responseText);
}

// Dự phòng khi trình duyệt không đọc được địa chỉ phiên resumable: gửi một lần (multipart).
async function multipartUpload({ token, blob, name, mimeType, folderId, onProgress }) {
  const boundary = `dtvoice${Date.now()}`;
  const meta = JSON.stringify({ name, mimeType, parents: [folderId], description: 'Ghi âm cuộc họp bằng Đất Thủ Voice AI' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const xhr = await xhrRequest({
    method: 'POST',
    url: `${UPLOAD}?uploadType=multipart&fields=id,name,size`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    onUploadProgress: (loaded) => onProgress && onProgress(Math.min(blob.size, Math.round((loaded / body.size) * blob.size)), blob.size),
    timeout: 0,
  });
  if (xhr.status === 200 || xhr.status === 201) return safeJson(xhr.responseText);
  throw toDriveError(xhr.status, xhr.responseText);
}

// Kiểm tra file trên Drive đủ dung lượng trước khi app xóa bản trong máy.
async function verify(token, file, total) {
  if (!file || !file.id) throw new DriveError('Drive không trả mã file sau khi tải lên. Bản ghi vẫn giữ trong máy.');
  const meta = await api(token, `/files/${encodeURIComponent(file.id)}`, { query: { fields: 'id,name,size,webViewLink' } });
  if (Number(meta.size) !== total) {
    throw new DriveError(`File trên Drive (${meta.size} byte) không khớp bản trong máy (${total} byte). Bản ghi vẫn giữ trong máy, hãy tải lại.`);
  }
  return meta;
}

export async function uploadFile({ token, blob, name, mimeType, folderId, session, onProgress, onSession }) {
  const total = blob.size;
  if (!total) throw new DriveError('Bản ghi rỗng, không có gì để tải lên.');
  const report = (n) => onProgress && onProgress(Math.min(n, total), total);

  let uri = session && session.uri;
  let offset = (session && session.offset) || 0;
  if (uri) {
    try {
      const st = await queryStatus(uri, token, total, offset);
      if (st.done) return verify(token, st.file, total);
      offset = st.offset;
    } catch (e) {
      if (e instanceof DriveError && !e.retryable) uri = null; // phiên cũ hết hạn (404/410) → mở phiên mới
      else throw e;
    }
  }
  if (!uri) {
    uri = await createSession({ token, name, mimeType, folderId, total });
    offset = 0;
    if (!uri) {
      const file = await multipartUpload({ token, blob, name, mimeType, folderId, onProgress });
      return verify(token, file, total);
    }
    if (onSession) onSession({ uri, offset });
  }

  let attempt = 0;
  let restarted = false;
  report(offset);
  while (offset < total) {
    const start = offset;
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, total);
    try {
      const r = await putChunk({ uri, token, blob, start, end, total, onLoaded: (loaded) => report(start + loaded) });
      attempt = 0;
      if (r.done) { report(total); return verify(token, r.file, total); }
      offset = r.offset;
      if (onSession) onSession({ uri, offset });
      report(offset);
    } catch (e) {
      if (e instanceof DriveAuthError || e instanceof OfflineError) throw e;
      if (e instanceof DriveError && !e.retryable) {
        if (restarted) throw e;
        // Lệch vị trí byte với máy chủ: mở phiên mới, gửi lại từ đầu một lần.
        restarted = true;
        uri = await createSession({ token, name, mimeType, folderId, total });
        if (!uri) throw e;
        offset = 0;
        if (onSession) onSession({ uri, offset });
        continue;
      }
      attempt += 1;
      if (attempt > MAX_RETRIES) throw new OfflineError('Mạng chập chờn, chưa tải xong. Bản ghi vẫn giữ trong máy.');
      await sleep(Math.min(30000, 1000 * 2 ** (attempt - 1)));
      if (!navigator.onLine) throw offline();
      try {
        const st = await queryStatus(uri, token, total, offset);
        if (st.done) return verify(token, st.file, total);
        offset = st.offset;
      } catch (e2) {
        if (e2 instanceof DriveAuthError || e2 instanceof OfflineError) throw e2;
        // Hỏi trạng thái cũng lỗi: giữ vị trí cũ, vòng sau gửi lại.
      }
    }
  }
  throw new DriveError('Đã gửi đủ dữ liệu nhưng Drive chưa xác nhận. Bấm tải lại.', { retryable: true });
}
