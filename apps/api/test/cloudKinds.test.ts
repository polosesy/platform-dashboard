// Multi-cloud Phase 0 (docs/architecture/multi-cloud.md): the canonical taxonomy data, the resource-id → scope seam,
// and the connection file's provider default. Data checks only — nothing reads these at run time yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AZURE_GRAPH_KIND_CANONICAL, KIND_MAP, canonicalKindOf } from "../src/services/cloudKinds.js";
import { maskCloudIds, scopeOfResourceId } from "../src/infra/cloudRefs.js";

const ROOT = join(import.meta.dirname, "../../..");
const CANONICAL = new Set(KIND_MAP.map((m) => m.kind));

test("every Azure graph kind maps to a canonical kind of the table (or other)", () => {
  for (const [k, v] of Object.entries(AZURE_GRAPH_KIND_CANONICAL)) assert.ok(v === "other" || CANONICAL.has(v), `${k} → ${v}`);
});

test("every Azure native type exists in the REST-spec relationship catalog; AWS / GCP names are well-formed", () => {
  const catalog = JSON.parse(readFileSync(join(ROOT, "docs/architecture/relationships/catalog.json"), "utf8")).catalog as Record<string, unknown>;
  for (const m of KIND_MAP) {
    for (const t of m.azure ?? []) {
      assert.match(t, /^[a-z0-9.]+\/[a-z0-9/]+$/, `azure ${t}`);
      // Subscriptions and resource groups are ARM scopes, not provider resource types (not in the REST-spec catalog)
      if (m.kind.startsWith("scope.")) continue;
      assert.ok(t in catalog, `azure type not in catalog.json: ${t}`);
    }
    for (const t of m.aws ?? []) assert.match(t, /^AWS::\w+::\w+$/, `aws ${t}`);
    for (const t of m.gcp ?? []) assert.match(t, /^[a-z0-9-]+\.googleapis\.com\/[A-Z]\w+$/, `gcp ${t}`);
  }
});

test("each kind is covered on all three providers or says why not; a shared native type needs a discriminator", () => {
  for (const m of KIND_MAP) {
    for (const p of ["azure", "aws", "gcp"] as const) assert.ok((m[p]?.length ?? 0) > 0 || m.gap?.[p], `${m.kind}: ${p} neither mapped nor a gap`);
  }
  for (const p of ["azure", "aws", "gcp"] as const) {
    const seen = new Map<string, number>();
    for (const m of KIND_MAP) for (const t of m[p] ?? []) seen.set(t, (seen.get(t) ?? 0) + 1);
    for (const [t, n] of seen) if (n > 1) assert.ok(KIND_MAP.filter((m) => m[p]?.includes(t)).every((m) => m.discriminator), `${p} ${t} is in ${n} kinds without a discriminator`);
  }
  // The eight domains of the reference map each have a kind with all three providers present
  for (const d of ["compute", "db", "storage", "messaging", "serverless", "observability", "container", "ai"]) {
    assert.ok(KIND_MAP.some((m) => m.kind.startsWith(`${d}.`) && m.azure?.length && m.aws?.length && m.gcp?.length), d);
  }
  assert.equal(canonicalKindOf("azure", "Microsoft.ContainerService/managedClusters"), "container.cluster");
  assert.equal(canonicalKindOf("aws", "AWS::EKS::Cluster"), "container.cluster");
  assert.equal(canonicalKindOf("gcp", "container.googleapis.com/Cluster"), "container.cluster");
  assert.equal(canonicalKindOf("aws", "AWS::Nope::Thing"), "other");
  // No tenant data in the table
  assert.doesNotMatch(JSON.stringify(KIND_MAP), /[0-9a-f]{8}-[0-9a-f]{4}-|\d{12}/i);
});

test("resource id → scope: ARM subscription, ARN account, CAI project; ambiguous forms refused", () => {
  assert.deepEqual(scopeOfResourceId("/subscriptions/00000000-0000-0000-0000-00000000000A/resourceGroups/rg/providers/x/y/z"), { provider: "azure", kind: "subscription", id: "00000000-0000-0000-0000-00000000000a" });
  assert.deepEqual(scopeOfResourceId("arn:aws:ec2:ap-northeast-2:123456789012:instance/i-0abc"), { provider: "aws", kind: "account", id: "123456789012" });
  assert.deepEqual(scopeOfResourceId("//compute.googleapis.com/projects/my-proj-1/zones/asia-northeast3-a/instances/vm1"), { provider: "gcp", kind: "project", id: "my-proj-1" });
  assert.equal(scopeOfResourceId("arn:aws:s3:::my-bucket"), null, "S3 ARNs carry no account");
  assert.equal(scopeOfResourceId("//compute.googleapis.com/projects/123456789/zones/z/instances/i"), null, "a project number needs a lookup");
  assert.equal(scopeOfResourceId("/subscriptions/not-a-guid/x"), null);
  assert.equal(maskCloudIds("acct 123456789012 sub 00000000-0000-0000-0000-000000000001 //x.googleapis.com/projects/987654321/y"), "acct …9012 sub *** //x.googleapis.com/projects/***/y");
});
