import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

// Writes text owner-only and swaps it into place atomically. The temp name is unpredictable and created exclusively ('wx'),
// so a pre-planted file or symlink makes this fail instead of being written through; a failure removes only our own temp.
export function writePrivateFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      // writeSync may write fewer bytes than asked; loop until the whole export is out, then flush it before the swap.
      const buf = Buffer.from(text);
      for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
