// No control characters in source (2026-11-17): edits made through scripts turned regex `\b` into a backspace byte —
// `/^ARM 40[13]\b/` never matched (prometheusCollector: 401/403 not recognised) and `/\b429\b/` never matched
// (AzureRiskPanel: throttling recognised only by its wording). A NUL slipped into a string the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("tracked source has no control bytes (tab, LF, CR only)", () => {
  const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mjs", "*.css", "*.md", "*.json", "*.yaml"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(files.length > 100);
  const bad: string[] = [];
  for (const f of files) {
    let b: Buffer;
    try { b = readFileSync(`${root}${f}`); } catch { continue; }
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!;
      if (x < 32 && x !== 9 && x !== 10 && x !== 13) { bad.push(`${f}@${i}:${x}`); break; }
    }
  }
  assert.deepEqual(bad, []);
});
