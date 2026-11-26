// Đăng nhập Google phía trình duyệt bằng Google Identity Services (mô hình token, không cần máy chủ).
// Token sống khoảng 1 giờ, không có refresh token; hết hạn thì xin lại bằng một cú bấm.
import { DRIVE_SCOPE } from './config.js';

const TOKEN_KEY = 'dtvoice.token.v1';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const REQUEST_TIMEOUT_MS = 120000;

let gisPromise = null;

export function gisLoaded() {
  return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
}

export function loadGis(timeoutMs = 15000) {
  if (gisLoaded()) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.remove();
      gisPromise = null;
      reject(new AuthError(msg, 'gis_load'));
    };
    const timer = setTimeout(() => fail('Hết thời gian tải thư viện đăng nhập Google.'), timeoutMs);
    s.onload = () => {
      if (settled) return;
      if (!gisLoaded()) { fail('Thư viện đăng nhập Google không khả dụng.'); return; }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    s.onerror = () => fail('Không tải được thư viện đăng nhập Google (kiểm tra mạng).');
    document.head.appendChild(s);
  });
  return gisPromise;
}

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function readToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return t && t.access_token ? t : null;
  } catch {
    return null;
  }
}

function errorMessage(code) {
  switch (code) {
    case 'access_denied': return 'Bạn đã từ chối cấp quyền Google Drive.';
    case 'invalid_client':
    case 'unauthorized_client': return 'Client ID không đúng hoặc chưa khai báo địa chỉ trang này trong Google Cloud.';
    case 'popup_closed': return 'Cửa sổ đăng nhập Google đã bị đóng trước khi xong.';
    case 'popup_failed_to_open': return 'Trình duyệt chặn cửa sổ đăng nhập. Cho phép cửa sổ bật lên (pop-up) cho trang này rồi bấm lại.';
    default: return 'Đăng nhập Google không thành công. Thử lại.';
  }
}

export class GoogleAuth {
  constructor() {
    this.clientId = '';
    this.tokenClient = null;
    this.pending = null;
    this.token = readToken();
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }

  _emit() { this.listeners.forEach((fn) => fn(this.status())); }

  status() {
    if (!this.clientId) return 'unconfigured';
    if (this.isValid(0)) return 'connected';
    if (this.token) return 'expired';
    return 'disconnected';
  }

  setClientId(id) {
    if (id === this.clientId) return;
    this.clientId = id;
    this.tokenClient = null;
    if (this.token && this.token.clientId !== id) this.clear();
    else this._emit();
  }

  isValid(marginMs = 120000) {
    return !!(this.token && this.token.access_token && this.token.clientId === this.clientId
      && this.token.expiresAt - marginMs > Date.now());
  }

  get accessToken() {
    return this.isValid(0) ? this.token.access_token : null;
  }

  _initClient() {
    if (this.tokenClient) return;
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      prompt: '',
      callback: (resp) => this._onToken(resp),
      error_callback: (err) => this._onTokenError(err),
    });
  }

  // PHẢI gọi đồng bộ ngay trong sự kiện bấm của người dùng, trước mọi lệnh await,
  // để trình duyệt không chặn cửa sổ đăng nhập.
  requestToken() {
    if (this.isValid()) return Promise.resolve(this.token.access_token);
    if (!this.clientId) {
      return Promise.reject(new AuthError('Chưa nhập Google Client ID. Vào CÀI ĐẶT để nhập.', 'no_client'));
    }
    if (!gisLoaded()) {
      loadGis().catch(() => {});
      return Promise.reject(new AuthError('Thư viện đăng nhập Google chưa tải xong. Kiểm tra mạng, chờ vài giây rồi bấm lại.', 'gis_not_loaded'));
    }
    this._initClient();
    if (this.pending) this._settle(null, new AuthError('', 'superseded'));
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => this._settle(null, new AuthError(errorMessage('popup_closed'), 'timeout')), REQUEST_TIMEOUT_MS);
    this.pending = { resolve, reject, timer };
    try {
      this.tokenClient.requestAccessToken({ prompt: '' });
    } catch {
      this._settle(null, new AuthError(errorMessage('popup_failed_to_open'), 'popup_failed_to_open'));
    }
    return promise;
  }

  _settle(token, err) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(token);
  }

  _onToken(resp) {
    if (!resp || resp.error) {
      this._settle(null, new AuthError(errorMessage(resp && resp.error), (resp && resp.error) || 'unknown'));
      return;
    }
    if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      this._settle(null, new AuthError('Bạn chưa tích ô cho phép ứng dụng dùng Google Drive. Bấm kết nối lại và tích ô quyền Drive.', 'scope'));
      return;
    }
    this.token = {
      access_token: resp.access_token,
      expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
      clientId: this.clientId,
    };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(this.token)); } catch { /* bộ nhớ đầy */ }
    this._emit();
    this._settle(resp.access_token, null);
  }

  _onTokenError(err) {
    const code = (err && err.type) || 'unknown';
    this._settle(null, new AuthError(errorMessage(code), code));
  }

  // Gọi khi Drive trả 401: token còn hạn trên giấy nhưng đã bị thu hồi.
  invalidate() {
    if (this.token) {
      this.token.expiresAt = 0;
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify(this.token)); } catch { /* bỏ qua */ }
    }
    this._emit();
  }

  clear() {
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
    this._emit();
  }

  async signOut() {
    const t = this.token && this.token.access_token;
    this.clear();
    if (t && gisLoaded()) {
      await new Promise((resolve) => {
        try { window.google.accounts.oauth2.revoke(t, () => resolve()); } catch { resolve(); }
      });
    }
  }
}
