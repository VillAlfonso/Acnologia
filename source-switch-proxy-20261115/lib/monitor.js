import { appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';

export class Monitor {
  constructor(root) {
    this.file = path.join(root, 'monitor.log');
    this.queue = (async () => {
      const size = await stat(this.file).then(info => info.size).catch(() => 0);
      if (size > 10 * 1024 * 1024) await rename(this.file, `${this.file}.${Date.now()}.old`);
    })();
  }
  event(scope, message, level = 'info') {
    // Callers supply already-redacted events, never request bodies or field values.
    const clean = String(message).replace(/https?:\/\/[^\s]+/g, safePageURL).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\r\n]+/g, ' ').slice(0, 2500);
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${clean}\n`;
    this.queue = this.queue.catch(() => {}).then(() => appendFile(this.file, line));
  }
}

export function safePageURL(raw) {
  try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '(unknown page)'; }
}
