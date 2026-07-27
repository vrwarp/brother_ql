/**
 * A minimal observable store, so the demo needs no UI framework.
 */

export type Listener<T> = (state: T) => void;

export class Store<T extends object> {
  #state: T;
  #listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.#state = initial;
  }

  get state(): T {
    return this.#state;
  }

  update(patch: Partial<T>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  subscribe(listener: Listener<T>): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }
}

/** Run `fn` at most once per `delayMs`, on the trailing edge. */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
