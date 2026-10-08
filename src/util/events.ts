type AnyListener = (...args: any[]) => void;

/** Minimal typed event emitter. `on` returns a disposer. */
export class Emitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) listener(...args);
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
