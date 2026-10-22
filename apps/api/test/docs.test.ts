// The document process (docs/README.md › 문서 규칙): every doc has a header (status · owner · last-verified), every
// relative link resolves, docs/README.md lists every current doc, nothing current links into docs/archive/, no copies,
// and no tenant data. Files are what a commit would carry (tracked + new, .gitignore honoured — local notes never
// read). Stale docs (code under `covers` changed after last-verified) are reported as diagnostics, never failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, posix } from "node:path";

const ROOT = join(import.meta.dirname, "../../..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8").replace(/\r/g, "");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const files = git("ls-files", "--cached", "--others", "--exclude-standard", "--", "docs")
  .split("\n").filter((f) => f && existsSync(join(ROOT, f)));
const md = files.filter((f) => f.endsWith(".md"));
const isArchive = (f: string) => f.startsWith("docs/archive/");
const current = md.filter((f) => !isArchive(f));
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = new Set(["current", "draft", "archived"]);

function header(f: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(read(f));
  if (!m) return null;
  return Object.fromEntries(m[1]!.split("\n")
    .map((l) => /^([a-z-]+):\s*(.*?)\s*(?:#.*)?$/.exec(l))
    .filter((x): x is RegExpExecArray => !!x)
    .map((x) => [x[1]!, x[2]!]));
}

/** Relative markdown links outside code (fenced and inline), resolved to repo paths */
function links(f: string): Array<{ raw: string; to: string }> {
  const body = read(f).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...body.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => m[1]!)
    .filter((l) => !/^(https?:|mailto:|#)/.test(l))
    .map((l) => ({ raw: l, to: posix.normalize(posix.join(posix.dirname(f), decodeURI(l.split("#")[0]!))).replace(/\/$/, "") }));
}

test("every doc has a header: status, owner (a team), last-verified; archived ⇔ docs/archive/", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(md.length > 20);
  for (const f of md) {
    const h = header(f);
    assert.ok(h, `${f}: missing front matter (--- status / owner / last-verified ---)`);
    assert.ok(STATUS.has(h.status ?? ""), `${f}: status must be current | draft | archived`);
    assert.ok(h.owner && !h.owner.includes("@"), `${f}: owner (a team, not a person)`);
    assert.match(h["last-verified"] ?? "", DATE, `${f}: last-verified YYYY-MM-DD`);
    assert.ok(h["last-verified"]! <= today, `${f}: last-verified in the future`);
    assert.equal(h.status === "archived", isArchive(f), `${f}: status archived ⇔ under docs/archive/`);
    if (isArchive(f) && !f.endsWith("archive/README.md")) {
      assert.match(h.archived ?? "", DATE, `${f}: archived date`);
      assert.ok(h.reason, `${f}: reason`);
      const to = posix.normalize(posix.join(posix.dirname(f), h["replaced-by"] ?? ""));
      assert.ok(existsSync(join(ROOT, to)) && !isArchive(to), `${f}: replaced-by must be a current doc`);
      assert.match(read(f), /\n> \*\*보관 문서/, `${f}: archive banner`);
    }
  }
});

test("relative links resolve (docs, CLAUDE.md, README.md)", () => {
  for (const f of [...md, "CLAUDE.md", "README.md"]) {
    for (const l of links(f)) assert.ok(existsSync(join(ROOT, l.to)), `${f} → ${l.raw}`);
  }
});

test("docs/README.md lists every current doc; the archive index lists every archived doc", () => {
  const listed = new Set(links("docs/README.md").map((l) => l.to));
  for (const f of current) if (f !== "docs/README.md") assert.ok(listed.has(f), `${f} is not listed in docs/README.md`);
  const archived = new Set(links("docs/archive/README.md").map((l) => l.to));
  for (const f of md.filter(isArchive)) {
    if (!f.endsWith("archive/README.md")) assert.ok(archived.has(f), `${f} is not in docs/archive/README.md`);
  }
});

test("nothing current links into the archive (only docs/README.md → the archive index)", () => {
  for (const f of current) {
    for (const l of links(f)) {
      if (!l.to.startsWith("docs/archive")) continue;
      assert.ok(f === "docs/README.md" && l.to === "docs/archive/README.md", `${f} links the archived ${l.raw}`);
    }
  }
  assert.doesNotMatch(read("CLAUDE.md"), /docs\/archive\/\d/, "CLAUDE.md names an archived doc");
});

test("CLAUDE.md: its docs/ paths exist and every docs folder has a row in the Docs table", () => {
  const claude = read("CLAUDE.md");
  for (const [, p] of claude.matchAll(/`(docs\/[^`\s]+)`/g)) {
    if (/[*<]/.test(p!)) continue;   // globs and placeholders
    assert.ok(existsSync(join(ROOT, p!)), `CLAUDE.md names a missing ${p}`);
  }
  const folders = new Set(current.map((f) => f.split("/")[1]!).filter((d) => !d.endsWith(".md")));
  for (const d of folders) assert.ok(claude.includes(`| \`docs/${d}/\``), `CLAUDE.md Docs table lacks docs/${d}/`);
});

test("no copies: only README.md directly under docs/, no two docs with the same body", () => {
  assert.deepEqual(md.filter((f) => f.split("/").length === 2 && f !== "docs/README.md"), []);
  const seen = new Map<string, string>();
  for (const f of md) {
    const body = read(f).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    assert.ok(!seen.has(body), `${f} duplicates ${seen.get(body)}`);
    seen.set(body, f);
  }
});

test("no tenant data: GUIDs only from public code constants, no value of the local connections file", () => {
  const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const allowed = new Set(["apps/api/src/services/featureCatalog.ts", "apps/api/src/infra/azureClientFactory.ts"]
    .flatMap((p) => read(p).match(GUID) ?? []).map((g) => g.toLowerCase()));
  // The gitignored connections file (absent in CI) — its names and IDs must never reach a doc. Messages carry an
  // index only, never the value
  const conn = join(ROOT, "config/connections.json");
  const local = existsSync(conn)
    ? [...readFileSync(conn, "utf8").matchAll(/"(?:displayName|tenantName|tenantId|clientId)"\s*:\s*"([^"]{5,})"/g)]
      .map((m) => m[1]!.toLowerCase()).filter((v) => v !== "home")
    : [];
  for (const f of files.filter((x) => !x.endsWith("catalog.json"))) {   // catalog.json: relationshipCatalog.test.ts
    const text = read(f);
    for (const g of text.match(GUID) ?? []) assert.ok(allowed.has(g.toLowerCase()), `${f}: GUID ${g.slice(0, 8)}… — use a placeholder`);
    const lower = text.toLowerCase();
    local.forEach((v, i) => assert.ok(!lower.includes(v), `${f}: contains local connection value #${i}`));
  }
});

test("staleness report — code under `covers` changed after last-verified (diagnostic only)", (t) => {
  for (const f of current) {
    const h = header(f)!;
    if (!h.covers) continue;
    for (const p of h.covers.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean)) {
      assert.ok(existsSync(join(ROOT, p)), `${f}: covers a missing path ${p}`);
      const last = git("log", "-1", "--format=%cs", "--", p).trim();
      if (last && last > h["last-verified"]!) t.diagnostic(`${f}: ${p} changed ${last}, after last-verified ${h["last-verified"]}`);
    }
  }
});
