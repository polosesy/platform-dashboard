// Portal service names per resource type: the canonical-spelling table and its ko/en names stay in step.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as typesNs from "../../web/src/lib/azureTypes.ts";
import * as msgNs from "../../web/src/lib/i18nMessages.ts";

const A = ((typesNs as unknown as { default?: typeof typesNs }).default ?? typesNs) as typeof typesNs;
const M = ((msgNs as unknown as { default?: typeof msgNs }).default ?? msgNs) as typeof msgNs;

test("every table type has a ko and an en portal name, and every name has a table type", () => {
  for (const [lower, canonical] of Object.entries(A.AZ_TYPES)) {
    assert.equal(canonical.toLowerCase(), lower, canonical);
    const e = M.T[`aztype.${lower}`];
    assert.ok(e?.ko && e?.en, lower);
  }
  for (const key of Object.keys(M.MODULES.aztype!)) assert.ok(key.slice("aztype.".length) in A.AZ_TYPES, key);
});

test("names and ARM spelling, with a fallback for types outside the table", () => {
  const t = (k: string) => M.T[k]!.ko;
  assert.equal(A.typeName("microsoft.compute/virtualmachines", t), "가상 머신");
  assert.equal(A.armType("microsoft.compute/virtualmachines"), "Microsoft.Compute/virtualMachines");
  assert.equal(A.typeName("microsoft.keyvault/vaults", t) === A.typeName("microsoft.recoveryservices/vaults", t), false, "the two 'vaults' stay apart");
  assert.equal(A.typeNameKey("microsoft.contoso/widgets"), null);
  assert.equal(A.typeName("microsoft.contoso/widgets", t), "contoso · widgets");
  assert.equal(A.armType("microsoft.contoso/widgets"), "contoso · widgets");
});
