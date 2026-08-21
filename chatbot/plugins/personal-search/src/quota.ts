import { SearchError } from "./errors.js";

export interface SearchQuotaOptions {
  maxPerMinute?: number;
  maxPerDay?: number;
  maxConcurrent?: number;
  now?: () => number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class SearchQuota {
  readonly #maxPerMinute: number;
  readonly #maxPerDay: number;
  readonly #maxConcurrent: number;
  readonly #now: () => number;
  #minuteWindow = -1;
  #dayWindow = -1;
  #minuteCount = 0;
  #dayCount = 0;
  #inFlight = 0;

  constructor(options: SearchQuotaOptions = {}) {
    this.#maxPerMinute = positiveInteger(options.maxPerMinute, 6);
    this.#maxPerDay = positiveInteger(options.maxPerDay, 50);
    this.#maxConcurrent = positiveInteger(options.maxConcurrent, 1);
    this.#now = options.now ?? Date.now;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.#acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  snapshot(): {
    minuteCount: number;
    dayCount: number;
    inFlight: number;
  } {
    this.#refreshWindows();
    return {
      minuteCount: this.#minuteCount,
      dayCount: this.#dayCount,
      inFlight: this.#inFlight,
    };
  }

  #acquire(): () => void {
    this.#refreshWindows();
    if (this.#inFlight >= this.#maxConcurrent) {
      throw new SearchError("QUOTA_EXCEEDED");
    }
    if (this.#minuteCount >= this.#maxPerMinute || this.#dayCount >= this.#maxPerDay) {
      throw new SearchError("QUOTA_EXCEEDED");
    }

    this.#minuteCount += 1;
    this.#dayCount += 1;
    this.#inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight = Math.max(0, this.#inFlight - 1);
    };
  }

  #refreshWindows(): void {
    const now = this.#now();
    const minuteWindow = Math.floor(now / MINUTE_MS);
    const dayWindow = Math.floor(now / DAY_MS);
    if (minuteWindow !== this.#minuteWindow) {
      this.#minuteWindow = minuteWindow;
      this.#minuteCount = 0;
    }
    if (dayWindow !== this.#dayWindow) {
      this.#dayWindow = dayWindow;
      this.#dayCount = 0;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
