import { ConnectorError } from "./errors.js";

interface Entry {
  readonly exp: number;
  readonly value: unknown;
}

/** In-memory TTL cache. Callers re-parse values with their Zod schema on read. */
export class TtlCache {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly now: () => number) {}

  get(key: string): unknown {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (hit.exp <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: unknown, ttlSec: number): void {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      throw new ConnectorError("config", "Cache TTL must be a positive number of seconds.");
    }
    this.map.set(key, { exp: this.now() + ttlSec * 1000, value });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
