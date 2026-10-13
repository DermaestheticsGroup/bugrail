import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

// Writes text owner-only and swaps it into place atomically. The temp name is unpredictable and created exclusively ('wx'),
// so a pre-planted file or symlink makes this fail instead of being written through; a failure removes only our own temp.
export function writePrivateFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeSync(fd, text); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
