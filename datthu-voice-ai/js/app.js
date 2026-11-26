// Điều phối giao diện: ghi âm → lưu máy → tải lên Drive → chọn kịch bản phân tích Gemini.
import { APP_VERSION, DRIVE_FOLDER_NAME, KEEP_UPLOADED_HISTORY } from './config.js';
import {
  loadSettings, saveSettings, validateSettings, defaultSettings, fillTemplate, templateVars,
  formatHMS, formatDateTime, formatBytes,
} from './settings.js';
import * as store from './storage.js';
import { MeetingRecorder, isRecordingSupported, supportReport } from './recorder.js';
import { ScreenWakeLock } from './wakelock.js';
import { GoogleAuth, AuthError, loadGis } from './auth.js';
import { ensureFolder, uploadFile, getAccount, DriveAuthError, OfflineError } from './drive.js';

const $ = (id) => document.getElementById(id);
const ACCOUNT_KEY = 'dtvoice.account.v1';
const RETRY_DELAY_MS = 60000;

const state = {
  settings: loadSettings(),
  phase: 'idle', // idle | starting | recording | paused | saving
  recorder: null,
  timerId: null,
  uploadingId: null,
  queueRunning: false,
  current: null, // bản ghi đang hiện ở khung phân tích
  memoryBlobs: new Map(), // bản ghi không ghi được xuống máy: giữ trong RAM để vẫn tải lên được
  pending: [],
  uploaded: [],
  lastPercent: -1,
  retryTimer: null,
  waitingWorker: null,
  updateRequested: false,
  account: localStorage.getItem(ACCOUNT_KEY) || '',
  wake: 'off',
};

const auth = new GoogleAuth();
const wake = new ScreenWakeLock((s) => { state.wake = s; renderStatus(); });

// ---------- Tiện ích hiển thị ----------

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function show(el, visible) {
  if (el.hidden === visible) el.hidden = !visible;
}

function showNotice(text, { copyText = '', link = '' } = {}) {
  setText($('noticeText'), text);
  const box = $('noticeCopy');
  box.value = copyText;
  show(box, !!copyText);
  const a = $('noticeLink');
  if (link) a.href = link;
  show(a, !!link);
  show($('notice'), true);
  $('notice').scrollIntoView({ block: 'nearest' });
}

function hideNotice() {
  show($('notice'), false);
}

function isBusyRecording() {
  return ['starting', 'recording', 'paused', 'saving'].includes(state.phase);
}

// ---------- Trạng thái ----------

function renderStatus() {
  const st = auth.status();
  const drive = {
    unconfigured: 'CHƯA NHẬP CLIENT ID',
    disconnected: 'CHƯA KẾT NỐI',
    expired: 'PHIÊN HẾT HẠN · tự xin lại khi lưu',
    connected: `ĐÃ KẾT NỐI${state.account ? ` · ${state.account}` : ''}`,
  }[st];
  setText($('stDrive'), drive);
  setText($('stNet'), navigator.onLine ? 'CÓ KẾT NỐI' : 'MẤT KẾT NỐI · vẫn ghi âm được');
  const wakeText = {
    on: 'GIỮ SÁNG KHI GHI',
    lost: 'ĐANG XIN GIỮ SÁNG LẠI',
    unsupported: 'MÁY KHÔNG HỖ TRỢ GIỮ SÁNG · chỉnh giờ tắt màn hình',
    error: 'KHÔNG GIỮ SÁNG ĐƯỢC · chỉnh giờ tắt màn hình',
    off: 'TỰ TẮT THEO MÁY',
  }[state.wake] || 'TỰ TẮT THEO MÁY';
  setText($('stWake'), wakeText);

  const btn = $('btnConnect');
  let label = '';
  if (st === 'unconfigured') label = 'NHẬP GOOGLE CLIENT ID ĐỂ KẾT NỐI DRIVE';
  else if (st === 'disconnected') label = state.pending.length ? 'KẾT NỐI GOOGLE DRIVE & TẢI LÊN' : 'KẾT NỐI GOOGLE DRIVE';
  else if (st === 'expired' && state.pending.length) label = 'KẾT NỐI LẠI & TẢI LÊN';
  setText(btn, label);
  show(btn, !!label);
}

function render() {
  const p = state.phase;
  const recording = p === 'recording' || p === 'paused';
  show($('btnStart'), p === 'idle');
  show($('recControls'), recording);
  setText($('btnPause'), p === 'paused' ? 'TIẾP TỤC' : 'TẠM DỪNG');
  const mic = {
    idle: 'MIC: CHƯA GHI',
    starting: 'MIC: ĐANG MỞ…',
    recording: 'MIC: ĐANG GHI',
    paused: 'MIC: TẠM DỪNG',
    saving: 'MIC: ĐÃ TẮT · ĐANG LƯU',
  }[p];
  setText($('micState'), mic);
  show($('uploadPanel'), !!state.uploadingId);
  show($('analysisPanel'), !!state.current && !isBusyRecording());
  show($('updateBar'), !!state.waitingWorker && p === 'idle' && !state.uploadingId);
  renderStatus();
}

// ---------- Đồng hồ ----------

function tick() {
  const ms = state.recorder ? state.recorder.elapsedMs : 0;
  setText($('timer'), formatHMS(ms));
  const limit = state.settings.warnMinutes * 60000;
  const over = ms > limit;
  if (over) setText($('lengthWarn'), `ĐÃ GHI QUÁ ${state.settings.warnMinutes} PHÚT. Gói Gemini có thể không nhận hết file. Nên kết thúc và ghi phần tiếp theo thành file mới.`);
  show($('lengthWarn'), over);
}

function startTimer() {
  stopTimer();
  tick();
  state.timerId = setInterval(tick, 1000);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

// ---------- Danh sách bản ghi ----------

async function refreshLists() {
  let all = [];
  try { all = await store.listRecordings(); } catch { /* bộ nhớ máy lỗi: giữ danh sách rỗng */ }
  state.pending = all.filter((r) => r.status !== 'uploaded' && r.status !== 'recording').reverse();
  state.uploaded = all.filter((r) => r.status === 'uploaded');
  renderQueue();
  renderHistory();
  renderStatus();
}

function el(tag, attrs = {}, text = '') {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => { e[k] = v; });
  if (text) e.textContent = text;
  return e;
}

function renderQueue() {
  const list = $('queueList');
  list.replaceChildren();
  state.pending.forEach((r) => {
    const li = el('li');
    li.append(el('p', { className: 'filename' }, r.fileName));
    const status = r.id === state.uploadingId ? 'ĐANG TẢI LÊN' : 'CHỜ TẢI LÊN';
    li.append(el('p', { className: 'meta' }, `${formatDateTime(r.startedAt)} · ${formatHMS(r.durationMs || 0)} · ${formatBytes(r.size)} · ${status}`));
    if (r.error) li.append(el('p', { className: 'err' }, r.error));
    const row = el('div', { className: 'row' });
    const up = el('button', { className: 'btn btn-small', type: 'button' }, 'TẢI LÊN');
    up.addEventListener('click', () => onUploadClick(r.id));
    const del = el('button', { className: 'btn btn-small', type: 'button' }, 'XÓA');
    del.addEventListener('click', () => onDeleteClick(r));
    up.disabled = del.disabled = r.id === state.uploadingId;
    row.append(up, del);
    li.append(row);
    list.append(li);
  });
  setText($('queueCount'), String(state.pending.length));
  show($('queuePanel'), state.pending.length > 0);
  show($('btnRetryAll'), state.pending.length > 1);
}

function renderHistory() {
  const list = $('historyList');
  list.replaceChildren();
  state.uploaded.forEach((r) => {
    const li = el('li');
    li.append(el('p', { className: 'filename' }, r.fileName));
    li.append(el('p', { className: 'meta' }, `${formatDateTime(r.startedAt)} · ${formatHMS(r.durationMs || 0)} · ${formatBytes(r.size)}`));
    const row = el('div', { className: 'row' });
    const pick = el('button', { className: 'btn btn-small', type: 'button' }, 'PHÂN TÍCH FILE NÀY');
    pick.addEventListener('click', () => {
      state.current = r;
      renderAnalysis();
      render();
      $('analysisPanel').scrollIntoView({ block: 'start' });
    });
    row.append(pick);
    if (r.driveLink) row.append(el('a', { className: 'link', href: r.driveLink, target: '_blank', rel: 'noopener' }, 'Mở trên Drive'));
    li.append(row);
    list.append(li);
  });
  show($('historyPanel'), state.uploaded.length > 0);
}

async function pruneHistory() {
  const all = await store.listRecordings();
  const old = all.filter((r) => r.status === 'uploaded').slice(KEEP_UPLOADED_HISTORY);
  for (const r of old) await store.deleteRecording(r.id);
}

// ---------- Phân tích bằng Gemini ----------

function renderAnalysis() {
  const r = state.current;
  if (!r) return;
  setText($('anName'), r.fileName);
  setText($('anMeta'), `${formatDateTime(r.startedAt)} · ${formatHMS(r.durationMs || 0)} · ${formatBytes(r.size)} · thư mục ${DRIVE_FOLDER_NAME}`);
  $('anDriveLink').href = r.driveLink || 'https://drive.google.com/drive/my-drive';
  const box = $('anButtons');
  box.replaceChildren();
  state.settings.templates.forEach((t, i) => {
    const b = el('button', { className: 'btn btn-analysis', type: 'button' }, `PHÂN TÍCH: ${t.name}`);
    b.addEventListener('click', () => onAnalyze(i));
    box.append(b);
  });
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* thử cách dự phòng */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function onAnalyze(i) {
  const r = state.current;
  const tpl = state.settings.templates[i];
  if (!r || !tpl) return;
  const text = fillTemplate(tpl.text, templateVars(r));
  const url = state.settings.geminiUrl;
  // Sao chép trước khi mở tab mới: trang mất focus thì trình duyệt từ chối ghi clipboard.
  const copied = await copyToClipboard(text);
  let win = null;
  try {
    win = window.open(url, '_blank');
    if (win) win.opener = null;
  } catch { win = null; }
  const fileLine = `File cần chọn: ${r.fileName} (thư mục ${DRIVE_FOLDER_NAME}).`;
  if (copied) {
    showNotice(`ĐÃ SAO CHÉP LỆNH! Hãy bấm dấu (+) → Google Drive trong Gemini để chọn file vừa ghi âm. ${fileLine}`, { link: win ? '' : url });
  } else {
    showNotice(`Máy không cho tự sao chép. Chạm giữ ô dưới → Chọn tất cả → Sao chép, rồi mở Gemini. ${fileLine}`, { copyText: text, link: url });
  }
}

// ---------- Kết nối Google ----------

function authMessage(e) {
  if (e instanceof AuthError) return e.message;
  return 'Chưa kết nối được Google Drive.';
}

async function refreshAccount() {
  const token = auth.accessToken;
  if (!token || !navigator.onLine) return;
  try {
    const user = await getAccount(token);
    state.account = user.emailAddress || user.displayName || '';
    if (state.account) localStorage.setItem(ACCOUNT_KEY, state.account);
  } catch { /* không bắt buộc */ }
  renderStatus();
}

function onConnectClick() {
  if (auth.status() === 'unconfigured') { openSettings(); return; }
  const tokenPromise = auth.requestToken(); // đồng bộ trong cú bấm để không bị chặn cửa sổ
  tokenPromise.then(async () => {
    showNotice('Đã kết nối Google Drive.');
    await refreshAccount();
    await runQueue();
  }).catch((e) => {
    if (e.code !== 'superseded') showNotice(authMessage(e));
  });
}

// ---------- Ghi âm ----------

function micErrorMessage(e) {
  switch (e && e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Chưa cho phép dùng micro. Chạm biểu tượng ổ khóa cạnh địa chỉ trang (hoặc Cài đặt ứng dụng) → Quyền → Micro → Cho phép.';
    case 'NotFoundError':
      return 'Không tìm thấy micro trên máy.';
    case 'NotReadableError':
      return 'Micro đang bị ứng dụng khác dùng. Đóng ứng dụng đó rồi bấm lại.';
    default:
      return `Không mở được micro${e && e.message ? `: ${e.message}` : '.'}`;
  }
}

async function onStartClick() {
  if (state.phase !== 'idle') return;
  if (!window.isSecureContext) {
    showNotice('Ứng dụng phải chạy qua https:// mới ghi âm được.');
    return;
  }
  if (!isRecordingSupported()) {
    showNotice('Trình duyệt này không ghi âm được. Hãy mở bằng Google Chrome bản mới.');
    return;
  }
  hideNotice();
  state.phase = 'starting';
  render();
  const rec = new MeetingRecorder({
    formatPref: state.settings.formatPref,
    onInterrupted: (reason) => onInterrupted(reason),
    onStorageError: () => showNotice('Bộ nhớ máy không ghi thêm được (có thể đã đầy). Vẫn đang ghi âm vào RAM: đừng đóng ứng dụng, bấm KẾT THÚC & LƯU DRIVE sớm.'),
  });
  try {
    await rec.start();
  } catch (e) {
    state.phase = 'idle';
    render();
    showNotice(micErrorMessage(e));
    return;
  }
  state.recorder = rec;
  state.current = null;
  state.phase = 'recording';
  store.requestPersistence();
  wake.enable();
  startTimer();
  render();
}

function onPauseClick() {
  const r = state.recorder;
  if (!r) return;
  if (state.phase === 'recording') { r.pause(); state.phase = 'paused'; }
  else if (state.phase === 'paused') { r.resume(); state.phase = 'recording'; }
  tick();
  render();
}

function onStopClick() {
  if (state.phase !== 'recording' && state.phase !== 'paused') return;
  // Xin token ngay trong cú bấm (nếu cần) để cửa sổ đăng nhập không bị chặn.
  let tokenPromise = null;
  if (state.settings.clientId && navigator.onLine) {
    tokenPromise = auth.requestToken();
    tokenPromise.catch(() => {});
  }
  finishRecording(tokenPromise);
}

function onInterrupted(reason) {
  const tokenPromise = auth.isValid() ? Promise.resolve(auth.accessToken) : null;
  finishRecording(tokenPromise, reason);
}

async function finishRecording(tokenPromise, reason = '') {
  if (state.phase !== 'recording' && state.phase !== 'paused') return;
  state.phase = 'saving';
  render();
  stopTimer();
  const { rec, blob, storageOk } = await state.recorder.stop();
  setText($('timer'), formatHMS(rec.durationMs));
  state.recorder = null;
  await wake.disable();
  state.phase = 'idle';
  show($('lengthWarn'), false);
  if (!storageOk) state.memoryBlobs.set(rec.id, blob);
  if (!blob.size) {
    await store.deleteRecording(rec.id).catch(() => {});
    render();
    showNotice('Bản ghi rỗng: micro không thu được âm thanh. Kiểm tra quyền micro rồi ghi lại.');
    return;
  }
  render();
  await refreshLists();
  if (reason) showNotice(`${reason} Đã dừng và giữ phần đã ghi (${formatHMS(rec.durationMs)}).`);
  await uploadOne(rec.id, { blob, tokenPromise, showResult: true });
  runQueue();
}

// ---------- Tải lên Drive ----------

async function markPending(rec, message) {
  rec.status = 'pending';
  rec.error = message;
  try { await store.putRecording(rec); } catch { /* bỏ qua */ }
}

function updateProgress(sent, total) {
  const pct = total ? Math.floor((sent / total) * 100) : 0;
  if (pct === state.lastPercent) return; // E-Ink: chỉ vẽ lại khi số phần trăm đổi
  state.lastPercent = pct;
  $('upFill').style.width = `${pct}%`;
  $('upBar').setAttribute('aria-valuenow', String(pct));
  setText($('upText'), `${pct}% · ${formatBytes(sent)} / ${formatBytes(total)}`);
}

function scheduleRetry() {
  if (state.retryTimer) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (navigator.onLine && auth.isValid()) runQueue();
  }, RETRY_DELAY_MS);
}

// Trả true nếu tải lên thành công.
async function uploadOne(id, { blob = null, tokenPromise = null, showResult = false } = {}) {
  if (state.uploadingId) return false;
  const rec = await store.getRecording(id).catch(() => null);
  if (!rec || rec.status === 'uploaded') return false;

  if (!state.settings.clientId) {
    await markPending(rec, 'Chưa có Google Client ID. Vào CÀI ĐẶT để nhập, bản ghi vẫn giữ trong máy.');
    await refreshLists();
    if (showResult) showNotice('Đã lưu bản ghi trong máy. Cần nhập Google Client ID trong CÀI ĐẶT để tải lên Drive.');
    return false;
  }
  if (!navigator.onLine) {
    await markPending(rec, 'Mất mạng. Sẽ tự tải lên khi có mạng.');
    await refreshLists();
    if (showResult) showNotice('Mất mạng: bản ghi đã lưu trong máy và sẽ tự tải lên khi có mạng lại.');
    return false;
  }
  let token = null;
  try {
    token = tokenPromise ? await tokenPromise : auth.isValid() ? auth.accessToken : null;
  } catch (e) {
    await markPending(rec, `${authMessage(e)} Bản ghi vẫn giữ trong máy.`);
    await refreshLists();
    if (showResult && e.code !== 'superseded') showNotice(`${authMessage(e)} Bản ghi đã lưu trong máy, bấm KẾT NỐI để tải lên.`);
    return false;
  }
  if (!token) {
    await markPending(rec, 'Cần kết nối lại Google Drive để tải lên.');
    await refreshLists();
    if (showResult) showNotice('Bản ghi đã lưu trong máy. Bấm KẾT NỐI để tải lên Drive.');
    return false;
  }

  state.uploadingId = id;
  state.lastPercent = -1;
  setText($('upName'), rec.fileName);
  updateProgress(0, rec.size || 1);
  setText($('upStep'), `Kiểm tra thư mục ${DRIVE_FOLDER_NAME}…`);
  rec.status = 'uploading';
  rec.error = '';
  await store.putRecording(rec).catch(() => {});
  render();
  renderQueue();

  let ok = false;
  try {
    const folderId = await ensureFolder(token);
    setText($('upStep'), 'Đang tải lên. Giữ ứng dụng mở đến khi xong.');
    let data = blob || state.memoryBlobs.get(id);
    if (!data || !data.size) data = new Blob(await store.getChunkBlobs(id), { type: rec.mimeType });
    const file = await uploadFile({
      token,
      blob: data,
      name: rec.fileName,
      mimeType: rec.mimeType,
      folderId,
      session: rec.uploadSession,
      onProgress: updateProgress,
      onSession: (s) => { rec.uploadSession = s; store.putRecording(rec).catch(() => {}); },
    });
    Object.assign(rec, {
      status: 'uploaded',
      error: '',
      size: data.size,
      driveFileId: file.id,
      driveLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      uploadedAt: new Date().toISOString(),
      uploadSession: null,
    });
    await store.putRecording(rec);
    // File trên Drive đã khớp dung lượng: lúc này mới xóa bản trong máy.
    await store.deleteChunks(id).catch(() => {});
    state.memoryBlobs.delete(id);
    await pruneHistory().catch(() => {});
    ok = true;
    if (showResult || !state.current) {
      state.current = rec;
      renderAnalysis();
    }
    if (showResult) showNotice(`Đã lưu ${rec.fileName} vào thư mục ${DRIVE_FOLDER_NAME}. Chọn kịch bản phân tích bên dưới.`);
  } catch (e) {
    let msg;
    if (e instanceof DriveAuthError) {
      auth.invalidate();
      msg = `${e.message} Bấm KẾT NỐI LẠI & TẢI LÊN, bản ghi vẫn giữ trong máy.`;
    } else if (e instanceof OfflineError) {
      msg = `${e.message} Sẽ tự tải tiếp khi có mạng.`;
      scheduleRetry();
    } else {
      msg = `${e.message || 'Lỗi không xác định khi tải lên.'} Bản ghi vẫn giữ trong máy.`;
    }
    await markPending(rec, msg);
    if (showResult) showNotice(msg);
  } finally {
    state.uploadingId = null;
    render();
    await refreshLists();
  }
  return ok;
}

// Tải lần lượt các bản ghi đang chờ; dừng ở lỗi đầu tiên để không gọi Drive dồn dập.
async function runQueue() {
  if (state.queueRunning || state.uploadingId || !navigator.onLine || !auth.isValid()) return;
  state.queueRunning = true;
  try {
    const list = (await store.listRecordings()).filter((r) => r.status === 'pending').reverse();
    for (const r of list) {
      if (!auth.isValid() || !navigator.onLine) break;
      const ok = await uploadOne(r.id);
      if (!ok) break;
    }
  } finally {
    state.queueRunning = false;
  }
}

function onUploadClick(id) {
  if (state.uploadingId) {
    showNotice('Đang tải một bản ghi khác lên Drive. Chờ xong rồi bấm lại.');
    return;
  }
  const tokenPromise = auth.requestToken(); // trong cú bấm
  tokenPromise.catch(() => {});
  tokenPromise.then(() => refreshAccount()).catch(() => {});
  uploadOne(id, { tokenPromise, showResult: true }).then(() => runQueue());
}

function onRetryAllClick() {
  const tokenPromise = auth.requestToken();
  tokenPromise.then(() => { refreshAccount(); runQueue(); })
    .catch((e) => { if (e.code !== 'superseded') showNotice(authMessage(e)); });
}

// ---------- Xác nhận xóa ----------

function confirmBox(text, yesLabel = 'XÓA') {
  return new Promise((resolve) => {
    const d = $('confirmDialog');
    setText($('confirmText'), text);
    setText($('confirmYes'), yesLabel);
    const done = (v) => {
      $('confirmYes').onclick = null;
      $('confirmNo').onclick = null;
      d.onclose = null;
      if (d.open) d.close();
      resolve(v);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    d.onclose = () => done(false);
    d.showModal();
  });
}

async function onDeleteClick(r) {
  const ok = await confirmBox(`Xóa vĩnh viễn ${r.fileName} khỏi máy? Bản này CHƯA có trên Google Drive, xóa là mất hẳn.`);
  if (!ok) return;
  await store.deleteRecording(r.id).catch(() => {});
  state.memoryBlobs.delete(r.id);
  await refreshLists();
  showNotice(`Đã xóa ${r.fileName} khỏi máy.`);
}

// ---------- Cài đặt ----------

function fillSettingsForm(s) {
  $('setClientId').value = s.clientId;
  $('setGemini').value = s.geminiUrl;
  s.templates.forEach((t, i) => {
    $(`tplName${i}`).value = t.name;
    $(`tplText${i}`).value = t.text;
  });
  $('setFormat').value = s.formatPref;
  $('setWarn').value = String(s.warnMinutes);
}

function readSettingsForm() {
  const base = state.settings;
  return {
    clientId: $('setClientId').value.trim(),
    geminiUrl: $('setGemini').value.trim(),
    formatPref: $('setFormat').value === 'webm' ? 'webm' : 'auto',
    warnMinutes: Number($('setWarn').value),
    templates: base.templates.map((t, i) => ({
      id: t.id,
      name: $(`tplName${i}`).value.trim(),
      text: $(`tplText${i}`).value.trim(),
    })),
  };
}

function showFieldError(id, msg) {
  setText($(id), msg || '');
  show($(id), !!msg);
}

function openSettings() {
  fillSettingsForm(state.settings);
  ['errClientId', 'errGemini', 'errWarn', 'errTpl0', 'errTpl1', 'errTpl2'].forEach((id) => showFieldError(id, ''));
  const sup = supportReport();
  setText($('formatSupport'), `Máy này ghi được: M4A ${sup.m4a ? 'CÓ' : 'KHÔNG'} · WebM ${sup.webm ? 'CÓ' : 'KHÔNG'}. Gemini nhận M4A chắc chắn hơn WebM.`);
  setText($('accountLine'), state.account ? `Tài khoản Google đang dùng: ${state.account}` : 'Chưa kết nối tài khoản Google.');
  $('settingsDialog').showModal();
}

function onSaveSettings(ev) {
  ev.preventDefault();
  const next = readSettingsForm();
  const errors = validateSettings(next);
  showFieldError('errClientId', errors.clientId);
  showFieldError('errGemini', errors.geminiUrl);
  showFieldError('errWarn', errors.warnMinutes);
  [0, 1, 2].forEach((i) => showFieldError(`errTpl${i}`, errors[`tpl${i}`]));
  if (Object.keys(errors).length) {
    const first = $('settingsForm').querySelector('.field-error:not([hidden])');
    if (first) first.scrollIntoView({ block: 'center' });
    return;
  }
  const clientChanged = next.clientId !== state.settings.clientId;
  saveSettings(next);
  state.settings = next;
  auth.setClientId(next.clientId);
  if (clientChanged) {
    state.account = '';
    localStorage.removeItem(ACCOUNT_KEY);
  }
  if (next.clientId) loadGis().catch(() => {});
  renderAnalysis();
  render();
  $('settingsDialog').close();
  showNotice(clientChanged && next.clientId ? 'Đã lưu cài đặt. Bấm KẾT NỐI GOOGLE DRIVE để đăng nhập.' : 'Đã lưu cài đặt.');
}

function onResetTemplates() {
  defaultSettings().templates.forEach((t, i) => {
    $(`tplName${i}`).value = t.name;
    $(`tplText${i}`).value = t.text;
  });
}

async function onSignOut() {
  const ok = await confirmBox('Ngắt kết nối tài khoản Google khỏi ứng dụng này? Bản ghi chưa tải lên vẫn giữ trong máy.', 'NGẮT KẾT NỐI');
  if (!ok) return;
  await auth.signOut();
  state.account = '';
  localStorage.removeItem(ACCOUNT_KEY);
  localStorage.removeItem('dtvoice.folderId.v1');
  setText($('accountLine'), 'Chưa kết nối tài khoản Google.');
  render();
  showNotice('Đã ngắt kết nối Google.');
}

// ---------- Mạng, khôi phục, cập nhật ----------

function onOnline() {
  renderStatus();
  if (state.settings.clientId) loadGis().catch(() => {});
  if (auth.isValid()) runQueue();
  else if (state.pending.length) showNotice(`Đã có mạng lại. Bấm KẾT NỐI để tải ${state.pending.length} bản ghi lên Drive.`);
}

// Bản ghi dở dang do app bị đóng: chuyển sang chờ tải lên, không bỏ phần đã ghi.
async function recoverInterrupted() {
  let all = [];
  try { all = await store.listRecordings(); } catch { return; }
  for (const r of all) {
    if (r.status !== 'recording' && r.status !== 'uploading') continue;
    if (r.status === 'recording' && !r.chunkCount) {
      await store.deleteRecording(r.id).catch(() => {});
      continue;
    }
    const msg = r.status === 'recording'
      ? 'Ứng dụng bị đóng khi đang ghi. Đã khôi phục phần ghi được.'
      : 'Lần tải lên trước bị gián đoạn. Sẽ tải tiếp.';
    await markPending(r, msg);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('service-worker.js').then((reg) => {
    const offer = (w) => { state.waitingWorker = w; render(); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !isBusyRecording()) reg.update().catch(() => {});
    });
  }).catch(() => { /* không có service worker vẫn chạy được khi có mạng */ });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Chỉ tải lại khi người dùng bấm CẬP NHẬT, không bao giờ tự tải lại giữa lúc ghi.
    if (state.updateRequested) location.reload();
  });
}

function onUpdateClick() {
  if (!state.waitingWorker || isBusyRecording() || state.uploadingId) return;
  state.updateRequested = true;
  state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

// ---------- Khởi động ----------

async function init() {
  setText($('appVersion'), APP_VERSION);
  auth.setClientId(state.settings.clientId);
  auth.onChange(() => renderStatus());

  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', () => $('settingsDialog').close());
  $('settingsForm').addEventListener('submit', onSaveSettings);
  $('btnResetTemplates').addEventListener('click', onResetTemplates);
  $('btnSignOut').addEventListener('click', onSignOut);
  $('btnConnect').addEventListener('click', onConnectClick);
  $('btnStart').addEventListener('click', onStartClick);
  $('btnPause').addEventListener('click', onPauseClick);
  $('btnStop').addEventListener('click', onStopClick);
  $('btnRetryAll').addEventListener('click', onRetryAllClick);
  $('noticeClose').addEventListener('click', hideNotice);
  $('btnUpdate').addEventListener('click', onUpdateClick);

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', renderStatus);
  window.addEventListener('beforeunload', (e) => {
    if (isBusyRecording() || state.uploadingId) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.recorder) tick();
      renderStatus();
    }
  });

  render();
  registerServiceWorker();
  await recoverInterrupted();
  await refreshLists();
  render();

  if (state.settings.clientId && navigator.onLine) {
    loadGis().catch(() => {});
    if (auth.isValid()) {
      refreshAccount();
      runQueue();
    }
  }
  if (state.pending.length && !auth.isValid()) {
    showNotice(`Có ${state.pending.length} bản ghi chưa lên Drive. Bấm KẾT NỐI để tải lên.`);
  }
}

init();
