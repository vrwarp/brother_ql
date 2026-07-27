/**
 * A small typed wrapper over `EventTarget`.
 *
 * `EventTarget` exists both in browsers and in Node 18+, so this works in both
 * without pulling in an event emitter dependency. The type parameter maps event
 * names to their event types, so `on` gives listeners a properly typed argument
 * while the inherited `addEventListener` stays available for anything that
 * expects the standard interface.
 */

export type EventMap = Record<string, Event>;

export class TypedEventTarget<TEvents extends EventMap> extends EventTarget {
  /**
   * Subscribe to an event.
   *
   * @returns a function that removes the listener again.
   */
  on<K extends keyof TEvents & string>(
    type: K,
    listener: (event: TEvents[K]) => void,
  ): () => void {
    const wrapped = listener as EventListener;
    this.addEventListener(type, wrapped);
    return () => this.removeEventListener(type, wrapped);
  }

  /** Unsubscribe a listener previously passed to {@link on}. */
  off<K extends keyof TEvents & string>(type: K, listener: (event: TEvents[K]) => void): void {
    this.removeEventListener(type, listener as EventListener);
  }

  /** Subscribe to the next occurrence of an event only. */
  once<K extends keyof TEvents & string>(
    type: K,
    listener: (event: TEvents[K]) => void,
  ): () => void {
    const wrapped = listener as EventListener;
    this.addEventListener(type, wrapped, { once: true });
    return () => this.removeEventListener(type, wrapped);
  }

  protected emit<K extends keyof TEvents & string>(type: K, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
