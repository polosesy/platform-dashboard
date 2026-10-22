// Resource identifiers of the three providers → their scope (Phase 0 of docs/architecture/multi-cloud.md). Pure; no
// route uses it yet — it is the seam a later authorize.ts reads scopes through (today it finds subscriptions by GUID
// only). Tested in apps/api/test/cloudRefs.test.ts.
import type { ScopeRef } from "@aud/types";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** arn:<partition>:<service>:<region>:<12-digit account>:<resource> (S3 buckets have no account — refused) */
const ARN = /^arn:(aws|aws-cn|aws-us-gov):([a-z0-9-]+):([a-z0-9-]*):(\d{12}):(.+)$/;
/** //<service>.googleapis.com/projects/<project id>/… (a project NUMBER needs a lookup — refused here) */
const CAI = /^\/\/([a-z0-9-]+)\.googleapis\.com\/projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])(\/.*)?$/;

/** The scope a resource id belongs to: an ARM id's subscription, an ARN's account, a CAI name's project; null = not
 *  one of these (or a form that needs a lookup) */
export function scopeOfResourceId(id: string): ScopeRef | null {
  const arm = /^\/subscriptions\/([^/]+)(\/|$)/i.exec(id);
  if (arm) return GUID.test(arm[1]!) ? { provider: "azure", kind: "subscription", id: arm[1]!.toLowerCase() } : null;
  const arn = ARN.exec(id);
  if (arn) return { provider: "aws", kind: "account", id: arn[4]! };
  const cai = CAI.exec(id);
  if (cai) return { provider: "gcp", kind: "project", id: cai[2]! };
  return null;
}

/** Mask scope identifiers in text: GUIDs, 12-digit AWS accounts (…last 4), GCP project numbers in CAI names */
export function maskCloudIds(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "***")
    .replace(/(?<!\d)\d{8}(\d{4})(?!\d)/g, "…$1")
    .replace(/(\/projects\/)\d{6,}(?=\/|$)/g, "$1***");
}
