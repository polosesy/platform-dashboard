// GUID masking for anything that leaves the app (exported files, cross-joined tables).
// Same rule as the API (apps/api/src/services/securityPosture.ts maskGuids): keep the last 4 characters.
// Default Azure resource names embed the subscription ID (e.g. "DefaultWorkspace-<sub>-EUS").

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function maskGuids(s: string): string {
  return s.replace(GUID_RE, (g) => `…${g.slice(-4)}`);
}

export function hasGuid(s: string): boolean {
  GUID_RE.lastIndex = 0;
  const found = GUID_RE.test(s);
  GUID_RE.lastIndex = 0;
  return found;
}
