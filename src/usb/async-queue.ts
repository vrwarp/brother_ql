/**
 * A queue that hands items from a producer to waiting consumers.
 *
 * WebUSB's `transferIn` has no timeout and cannot be cancelled, so a pending
 * read stays pending until data arrives or the device is closed. Racing a
 * transfer against a timer is therefore unsafe: the losing transfer stays
 * outstanding and swallows the *next* packet.
 *
 * The transport instead keeps one perpetual reader running and pushes what it
 * receives here. Timeouts live on this side, where a consumer that gives up
 * removes only its own waiter and no data is ever lost.
 */

export interface TakeOptions {
  /** Give up after this many milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Thrown by {@link AsyncQueue.take} when `timeoutMs` elapses. */
export class QueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms waiting for data.`);
    this.name = 'QueueTimeoutError';
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: Waiter<T>[] = [];
  #failure: Error | null = null;

  get size(): number {
    return this.#items.length;
  }

  /** Whether the queue has been failed and will not deliver anything further. */
  get failed(): boolean {
    return this.#failure !== null;
  }

  push(item: T): void {
    if (this.#failure) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(item);
      return;
    }
    this.#items.push(item);
  }

  /** Take the next item without waiting. */
  tryTake(): T | undefined {
    return this.#items.shift();
  }

  /** Wait for the next item. */
  take(options: TakeOptions = {}): Promise<T> {
    const buffered = this.#items.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.#failure) return Promise.reject(this.#failure);

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
      };

      waiter.resolve = (value: T): void => {
        cleanup();
        resolve(value);
      };
      waiter.reject = (error: Error): void => {
        cleanup();
        reject(error);
      };

      function onAbort(): void {
        waiter.reject(new Error('Aborted while waiting for data.'));
      }

      if (options.signal) {
        if (options.signal.aborted) {
          reject(new Error('Aborted while waiting for data.'));
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (options.timeoutMs !== undefined) {
        const timeoutMs = options.timeoutMs;
        timer = setTimeout(() => waiter.reject(new QueueTimeoutError(timeoutMs)), timeoutMs);
      }

      this.#waiters.push(waiter);
    });
  }

  /** Discard everything buffered, leaving waiters in place. */
  clear(): void {
    this.#items = [];
  }

  /**
   * Reject every current and future consumer.
   *
   * Used when the device disconnects, so that callers fail promptly instead of
   * waiting for a timeout that can no longer be satisfied.
   */
  fail(error: Error): void {
    this.#failure = error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /** Clear a previous failure so the queue can be used again. */
  reset(): void {
    this.#failure = null;
    this.#items = [];
  }
}
