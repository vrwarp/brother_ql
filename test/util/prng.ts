/**
 * A deterministic PRNG for the fuzz suites.
 *
 * Everything is seeded and nothing reads the clock, so a failing case is
 * reproducible by its seed alone: every fuzz assertion carries `seed=N` in its
 * message, and re-running the suite replays the identical inputs. mulberry32
 * is small, fast and passes gjrand; statistical quality beyond that is not the
 * point here — coverage of odd shapes is.
 */

export class Prng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
    // Avoid the all-zero state, which mulberry32 leaves quickly anyway, but
    // deterministically distinct seeds should give distinct streams.
    if (this.#state === 0) this.#state = 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, boundExclusive). */
  int(boundExclusive: number): number {
    return Math.floor(this.next() * boundExclusive);
  }

  /** Integer in [lo, hi], both inclusive. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  byte(): number {
    return this.int(256);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  /** Uniformly random bytes. */
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.byte();
    return out;
  }

  /**
   * Bytes with run structure: alternating runs of a repeated value and runs of
   * noise, with occasional long runs. This is the shape raster rows actually
   * have, and it exercises every state transition in the PackBits encoder.
   */
  runnyBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let i = 0;
    while (i < length) {
      const runLength = Math.min(
        length - i,
        this.bool(0.2) ? this.range(120, 300) : this.range(1, 12),
      );
      if (this.bool(0.6)) {
        out.fill(this.byte(), i, i + runLength);
      } else {
        for (let j = i; j < i + runLength; j++) out[j] = this.byte();
      }
      i += runLength;
    }
    return out;
  }

  /** A random RGBA image of the given size. */
  rgbaImage(width: number, height: number): { width: number; height: number; data: Uint8Array } {
    return { width, height, data: this.bytes(width * height * 4) };
  }
}

/**
 * Run a property across a range of seeds.
 *
 * The callback's failures are augmented with the seed, so the exact case can
 * be replayed with `new Prng(seed)` in isolation.
 */
export function forEachSeed(count: number, run: (prng: Prng, seed: number) => void): void {
  for (let seed = 1; seed <= count; seed++) {
    try {
      run(new Prng(seed), seed);
    } catch (error) {
      if (error instanceof Error) {
        error.message = `[seed=${seed}] ${error.message}`;
      }
      throw error;
    }
  }
}
