// Đọc, ghi, kiểm tra cài đặt (lưu trong localStorage của máy).
import {
  DEFAULT_CLIENT_ID, DEFAULT_GEMINI_URL, DEFAULT_TEMPLATES, DEFAULT_WARN_MINUTES, DRIVE_FOLDER_NAME,
} from './config.js';

const KEY = 'dtvoice.settings.v1';

export function defaultSettings() {
  return {
    clientId: DEFAULT_CLIENT_ID,
    geminiUrl: DEFAULT_GEMINI_URL,
    formatPref: 'auto',
    warnMinutes: DEFAULT_WARN_MINUTES,
    templates: DEFAULT_TEMPLATES.map((t) => ({ ...t })),
  };
}

function normalizeTemplates(list, defaults) {
  return defaults.map((def, i) => {
    const t = Array.isArray(list) ? list[i] : null;
    const name = t && typeof t.name === 'string' && t.name.trim() ? t.name.trim() : def.name;
    const text = t && typeof t.text === 'string' && t.text.trim() ? t.text.trim() : def.text;
    return { id: def.id, name, text };
  });
}

export function loadSettings() {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const warn = Number(s.warnMinutes);
    return {
      clientId: typeof s.clientId === 'string' && s.clientId.trim() ? s.clientId.trim() : d.clientId,
      geminiUrl: typeof s.geminiUrl === 'string' && s.geminiUrl.trim() ? s.geminiUrl.trim() : d.geminiUrl,
      formatPref: s.formatPref === 'webm' ? 'webm' : 'auto',
      warnMinutes: Number.isInteger(warn) && warn > 0 ? warn : d.warnMinutes,
      templates: normalizeTemplates(s.templates, d.templates),
    };
  } catch {
    return d;
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

// Trả về danh sách lỗi theo ô nhập; rỗng nghĩa là hợp lệ.
export function validateSettings(s) {
  const errors = {};
  if (s.clientId && !/^[\w.-]+\.apps\.googleusercontent\.com$/i.test(s.clientId)) {
    errors.clientId = 'Client ID phải có dạng 1234567890-abc...xyz.apps.googleusercontent.com';
  }
  try {
    const u = new URL(s.geminiUrl);
    if (u.protocol !== 'https:') errors.geminiUrl = 'Đường dẫn phải bắt đầu bằng https://';
  } catch {
    errors.geminiUrl = 'Đường dẫn không hợp lệ. Ví dụ: https://gemini.google.com/app';
  }
  if (!Number.isInteger(s.warnMinutes) || s.warnMinutes < 1 || s.warnMinutes > 1440) {
    errors.warnMinutes = 'Nhập số phút nguyên từ 1 đến 1440.';
  }
  s.templates.forEach((t, i) => {
    if (!t.name.trim() || !t.text.trim()) errors[`tpl${i}`] = 'Mẫu lệnh cần có cả tên và nội dung.';
  });
  return errors;
}

export function formatHMS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

export function templateVars(rec) {
  return {
    TEN_FILE: rec.fileName,
    NGAY_GIO: formatDateTime(rec.startedAt),
    THOI_LUONG: formatHMS(rec.durationMs || 0),
    THU_MUC: DRIVE_FOLDER_NAME,
  };
}

export function fillTemplate(text, vars) {
  return text.replace(/\{(TEN_FILE|NGAY_GIO|THOI_LUONG|THU_MUC)\}/g, (m, k) => vars[k] ?? m);
}
