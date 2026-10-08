// @ts-check
// AttendanceService: sends scans to the backend, queues them when offline, replays them later.
// Kiosk keeps working through a Wi-Fi drop; queued scans keep their real timestamp.

/** @typedef {{sessionId: number, studentId: number, scannedAt: number}} QueuedScan */
/** @typedef {{already?: boolean, scannedAt: number}} SendResult */

export class AttendanceService {
  /** @param {{
   *   send: (sessionId: number, studentId: number, scannedAt: number) => Promise<SendResult>,
   *   storage?: {getItem(k: string): string | null, setItem(k: string, v: string): void},
   *   now?: () => number, key?: string, onChange?: (pending: number) => void }} deps
   *  send must throw an Error with `.status` for HTTP errors; anything without `.status` is a network failure. */
  constructor({ send, storage, now = Date.now, key = 'attendance-queue', onChange = () => {} }) {
    this.send = send; this.storage = storage; this.now = now; this.key = key; this.onChange = onChange;
    this.flushing = false;
  }

  /** @returns {QueuedScan[]} */
  queue() {
    try { return JSON.parse(this.storage?.getItem(this.key) || '[]'); } catch { return []; }
  }
  /** @param {QueuedScan[]} q */
  save(q) { try { this.storage?.setItem(this.key, JSON.stringify(q)); } catch { /* storage full/blocked: queue is best-effort */ } this.onChange(q.length); }
  pending() { return this.queue().length; }

  /** @param {number} sessionId @param {number} studentId
   *  @returns {Promise<{status: 'saved', already: boolean, scannedAt: number} | {status: 'queued', scannedAt: number}>} */
  async mark(sessionId, studentId) {
    const scannedAt = this.now();
    try {
      const r = await this.send(sessionId, studentId, scannedAt);
      return { status: 'saved', already: !!r.already, scannedAt: r.scannedAt };
    } catch (e) {
      if (/** @type {{status?: number}} */ (e).status) throw e; // server said no: not a connectivity problem
      const q = this.queue();
      if (!q.some((x) => x.sessionId === sessionId && x.studentId === studentId)) this.save([...q, { sessionId, studentId, scannedAt }]);
      return { status: 'queued', scannedAt };
    }
  }

  /** Remove a not-yet-synced scan (used by "Wrong person"). Returns true if it was still queued.
   *  @param {number} sessionId @param {number} studentId */
  cancel(sessionId, studentId) {
    const q = this.queue(), rest = q.filter((x) => !(x.sessionId === sessionId && x.studentId === studentId));
    if (rest.length === q.length) return false;
    this.save(rest);
    return true;
  }

  /** Replay queued scans in order. 4xx = permanent (drop), network/5xx = keep and try later. */
  async flush() {
    if (this.flushing) return { sent: 0, dropped: 0, remaining: this.pending() };
    this.flushing = true;
    let sent = 0, dropped = 0;
    try {
      for (const item of this.queue()) {
        try {
          await this.send(item.sessionId, item.studentId, item.scannedAt);
          sent++;
        } catch (e) {
          const status = /** @type {{status?: number}} */ (e).status;
          if (status && status < 500) dropped++;
          else break; // offline or server trouble: stop, retry later
        }
        this.save(this.queue().filter((x) => !(x.sessionId === item.sessionId && x.studentId === item.studentId)));
      }
    } finally { this.flushing = false; }
    return { sent, dropped, remaining: this.pending() };
  }
}
