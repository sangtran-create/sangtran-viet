// Giữ màn hình sáng khi đang ghi. Hệ thống tự nhả khóa khi app bị ẩn, nên xin lại khi app hiện lại.
export class ScreenWakeLock {
  constructor(onChange) {
    this.onChange = onChange;
    this.sentinel = null;
    this.wanted = false;
    document.addEventListener('visibilitychange', () => {
      if (this.wanted && document.visibilityState === 'visible') this._acquire();
    });
  }

  get supported() {
    return 'wakeLock' in navigator;
  }

  _emit(state) {
    if (this.onChange) this.onChange(state);
  }

  async enable() {
    this.wanted = true;
    await this._acquire();
  }

  async _acquire() {
    if (!this.supported) { this._emit('unsupported'); return; }
    if (this.sentinel && !this.sentinel.released) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      this.sentinel = s;
      this._emit('on');
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
        this._emit(this.wanted ? 'lost' : 'off');
      });
    } catch {
      this._emit('error');
    }
  }

  async disable() {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s) { try { await s.release(); } catch { /* đã nhả */ } }
    this._emit('off');
  }
}
