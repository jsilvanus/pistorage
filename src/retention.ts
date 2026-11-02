/** True when an object's retention deadline has passed. Objects without one never expire. */
export function isRetentionExpired(expiresAt: string | undefined, now: number): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}
