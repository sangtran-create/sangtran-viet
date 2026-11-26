// Ghi âm bằng MediaRecorder. Cứ 10 giây ghi một đoạn xuống IndexedDB để chống mất dữ liệu.
import { RECORD_TIMESLICE_MS, AUDIO_BITS_PER_SECOND } from './config.js';
import * as store from './storage.js';

// M4A (AAC) được Gemini nhận chắc chắn hơn WebM, nên ưu tiên khi máy ghi được.
const CANDIDATES = {
  auto: ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'],
  webm: ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4'],
};

function supports(type) {
  try { return window.MediaRecorder && MediaRecorder.isTypeSupported(type); } catch { return false; }
}

export function isRecordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function pickMimeType(pref = 'auto') {
  return (CANDIDATES[pref] || CANDIDATES.auto).find(supports) || '';
}

export function supportReport() {
  return {
    m4a: supports('audio/mp4;codecs=mp4a.40.2') || supports('audio/mp4'),
    webm: supports('audio/webm;codecs=opus') || supports('audio/webm'),
  };
}

export function describeMime(mime) {
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'video/mp4') return { base: 'audio/mp4', ext: 'm4a', label: 'M4A' };
  if (base === 'audio/ogg') return { base: 'audio/ogg', ext: 'ogg', label: 'OGG' };
  return { base: 'audio/webm', ext: 'webm', label: 'WEBM' };
}

// Chuẩn tên file: DatThu_YYYY-MM-DD_HH-mm.<đuôi>, theo giờ bắt đầu ghi.
export function buildFileName(date, ext) {
  const p = (n) => String(n).padStart(2, '0');
  return `DatThu_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}.${ext}`;
}

export class MeetingRecorder {
  constructor({ formatPref = 'auto', onInterrupted, onStorageError } = {}) {
    this.formatPref = formatPref;
    this.onInterrupted = onInterrupted;
    this.onStorageError = onStorageError;
    this.state = 'idle';
    this.accumulatedMs = 0;
    this.segmentStart = 0;
    this.seq = 0;
    this.memoryChunks = [];
    this.writeChain = Promise.resolve();
    this.writeError = null;
    this.interrupted = false;
  }

  get elapsedMs() {
    return this.accumulatedMs + (this.state === 'recording' ? performance.now() - this.segmentStart : 0);
  }

  async start() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (e && e.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      else throw e;
    }
    this.stream = stream;

    const mime = pickMimeType(this.formatPref);
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime
        ? { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
        : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    } catch {
      recorder = new MediaRecorder(stream);
    }
    this.recorder = recorder;

    const startedAt = new Date();
    recorder.ondataavailable = (e) => this._onData(e);
    recorder.onerror = (e) => this._interrupt(`Bộ ghi âm báo lỗi${e && e.error ? ` (${e.error.name})` : ''}.`);
    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => this._interrupt('Micro bị ngắt: ứng dụng khác chiếm micro hoặc micro bị rút.'));
    });

    try {
      recorder.start(RECORD_TIMESLICE_MS);
    } catch (e) {
      this._releaseStream();
      throw e;
    }
    this.state = 'recording';
    this.segmentStart = performance.now();

    const info = describeMime(recorder.mimeType || mime);
    this.rec = {
      id: `rec_${startedAt.getTime()}`,
      fileName: buildFileName(startedAt, info.ext),
      mimeType: info.base,
      formatLabel: info.label,
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      size: 0,
      chunkCount: 0,
      status: 'recording',
      error: '',
    };
    const snapshot = { ...this.rec };
    this.writeChain = this.writeChain.then(() => store.putRecording(snapshot)).catch((err) => this._storageFailed(err));
    return { ...this.rec };
  }

  _onData(e) {
    if (!e.data || e.data.size === 0) return;
    const blob = e.data;
    const seq = this.seq++;
    this.memoryChunks.push(blob);
    this.rec.size += blob.size;
    this.rec.chunkCount = this.seq;
    this.rec.durationMs = Math.round(this.elapsedMs);
    const snapshot = { ...this.rec };
    this.writeChain = this.writeChain
      .then(() => store.addChunk(snapshot.id, seq, blob))
      .then(() => store.putRecording(snapshot))
      .catch((err) => this._storageFailed(err));
  }

  _storageFailed(err) {
    // Bản trong bộ nhớ RAM vẫn còn, nên vẫn tải lên được nếu app chưa bị đóng.
    if (!this.writeError) {
      this.writeError = err;
      if (this.onStorageError) this.onStorageError(err);
    }
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.accumulatedMs += performance.now() - this.segmentStart;
    this.state = 'paused';
    try { this.recorder.requestData(); } catch { /* không bắt buộc */ }
  }

  resume() {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this.segmentStart = performance.now();
    this.state = 'recording';
  }

  _interrupt(reason) {
    if (this.interrupted || this.state === 'stopped' || this.state === 'idle') return;
    this.interrupted = true;
    if (this.onInterrupted) this.onInterrupted(reason);
  }

  _releaseStream() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // Dừng hẳn, chờ mọi đoạn đã ghi xuống máy, trả về bản ghi và Blob hoàn chỉnh.
  stop() {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (this.state === 'recording') this.accumulatedMs += performance.now() - this.segmentStart;
      this.state = 'stopped';
      const finish = async () => {
        this._releaseStream();
        await this.writeChain;
        this.rec.durationMs = Math.round(this.accumulatedMs);
        this.rec.status = 'pending';
        try { await store.putRecording(this.rec); } catch (err) { this._storageFailed(err); }
        resolve({
          rec: { ...this.rec },
          blob: new Blob(this.memoryChunks, { type: this.rec.mimeType }),
          storageOk: !this.writeError,
        });
      };
      if (!r || r.state === 'inactive') { finish(); return; }
      // Sự kiện dataavailable cuối cùng luôn đến trước sự kiện stop.
      r.addEventListener('stop', () => setTimeout(finish, 0), { once: true });
      try { r.stop(); } catch { finish(); }
    });
  }
}
