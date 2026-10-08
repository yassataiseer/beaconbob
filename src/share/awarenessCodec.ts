import * as decoding from 'lib0/decoding';

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** Parsed JSON state; `null` means the client went away. */
  state: unknown;
}

/**
 * Reads a y-protocols awareness update without applying it, so the host can check that a
 * member only speaks for their own client ids before forwarding anything.
 */
export function readAwarenessUpdate(update: Uint8Array): AwarenessEntry[] | undefined {
  try {
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > 16) return undefined;
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const state: unknown = JSON.parse(decoding.readVarString(decoder));
      entries.push({ clientId, clock, state });
    }
    return entries;
  } catch {
    return undefined;
  }
}
