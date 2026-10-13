export interface Clock {
  now(): string;
  observe(hlc: string): void;
}

const MAX_COUNTER = 99_999;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

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
      const [msPart, counterPart] = hlc.split('-');
      const ms = Number(msPart);
      const c = Number(counterPart);
      if (!Number.isFinite(ms) || !Number.isFinite(c)) return;
      if (ms > lastMs || (ms === lastMs && c > counter)) {
        lastMs = ms;
        counter = c;
      }
    },
  };
}
