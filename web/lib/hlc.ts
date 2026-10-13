export interface Clock {
  now(): string;
  observe(hlc: string): void;
}

const MAX_COUNTER = 99_999;
const pad = (n: number, width: number) => String(n).padStart(width, '0');
const HLC_RE = /^(\d{15})-(\d{5})-.+$/;
const MAX_DRIFT_MS = 24 * 3600_000;

// "<ms:15>-<counter:5>-<deviceId>": zero-padded so plain string comparison is time order.
export function createClock(deviceId: string, wall: () => number = Date.now): Clock {
  let lastMs = 0;
  let counter = -1;

  return {
    now() {
      const ms = wall();
      if (ms > lastMs) {
        lastMs = ms;
        counter = 0;
      } else {
        counter += 1;
        if (counter > MAX_COUNTER) {
          lastMs += 1;
          counter = 0;
        }
      }
      return `${pad(lastMs, 15)}-${pad(counter, 5)}-${deviceId}`;
    },
    observe(hlc) {
      const m = typeof hlc === 'string' ? HLC_RE.exec(hlc) : null;
      if (!m) return;
      const ms = Number(m[1]);
      const c = Number(m[2]);
      // A peer far ahead would drag every later timestamp forward with it.
      if (ms > wall() + MAX_DRIFT_MS) return;
      if (ms > lastMs || (ms === lastMs && c > counter)) {
        lastMs = ms;
        counter = c;
      }
    },
  };
}
