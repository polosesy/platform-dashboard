// Writes docs/integrations/azure/templates/aks/*.yaml from src/services/k8sReadSurface.ts
// (test/k8sReadSurface.test.ts fails when they drift). Run: npx tsx apps/api/scripts/gen-aks-rbac.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_MANIFESTS } from "../src/services/k8sReadSurface.js";

const dir = join(import.meta.dirname, "../../../docs/integrations/azure/templates/aks");
for (const [file, gen] of Object.entries(GENERATED_MANIFESTS)) {
  writeFileSync(join(dir, file), gen());
  console.log(`wrote ${file}`);
}
