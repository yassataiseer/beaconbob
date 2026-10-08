import { randomBytes } from 'node:crypto';
import { MAX_GROUP_NAME } from '../signaling/protocolTypes';

export type { GroupMemberInfo, GroupVisibility } from '../signaling/protocolTypes';

export const MAX_ADVERTISED_GROUPS = 5;
export const MAX_HOSTED_GROUPS = 20;

export function newGroupId(): string {
  return `g-${randomBytes(6).toString('hex')}`;
}

/**
 * Trims, collapses whitespace, drops a leading `#`, and removes `|` (the TXT record separator).
 * Returns `undefined` if nothing usable is left.
 */
export function normalizeGroupName(raw: string): string | undefined {
  const name = raw
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .slice(0, MAX_GROUP_NAME)
    .trim();
  return name || undefined;
}
