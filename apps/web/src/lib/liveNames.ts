// Short resource names for the live diagram — pure (tested in apps/api/test/liveCard.test.ts).
//
// Azure names repeat their VNet's words (vm-demo-ngf-a-poc-eus-001 inside vnet-demo-poc-eus-001).
// Inside that VNet the card only needs what is left ("ngf-a"); the full name stays in tooltips, search and
// the detail panel.

const SPLIT = /[-_.]/;
/** CAF abbreviations that only repeat the resource type the card already shows */
const CAF_PREFIX: Record<string, string[]> = {
  vm: ["vm", "vmss"],
  vmss: ["vmss"],
  lb: ["lb", "lbi"],
  appGateway: ["agw", "appgw"],
  publicIP: ["pip"],
  nic: ["nic"],
  privateEndpoint: ["pe", "pep"],
  natGateway: ["ng", "ngw"],
  nsg: ["nsg"],
  subnet: ["snet"],
  vnet: ["vnet"],
};

const tokensOf = (s: string) => s.split(SPLIT).filter(Boolean);

/** Words of the VNet name that resource names repeat (its own CAF prefix excluded) */
export function vnetWords(vnetName: string): Set<string> {
  return new Set(tokensOf(vnetName.toLowerCase()).filter((t) => t !== "vnet"));
}

/** A piece of the full name: a word or a separator, and whether the short name keeps it */
export type NamePart = { text: string; kept: boolean; sep?: boolean };

const keepToken = (t: string, words: ReadonlySet<string>) => {
  const low = t.toLowerCase();
  if (words.has(low)) return false;
  // A truncated VNet word ("00" of "001" in a cut-off VMSS instance name)
  for (const w of words) if (low.length >= 2 && low.length < w.length && w.startsWith(low)) return false;
  return true;
};

/**
 * The full name split into words and separators, each marked kept or dropped — the full-name tag shows the
 * short name's words in bold inside the full name. A separator is kept when the words on both sides are.
 */
function shortenParts(name: string, words: ReadonlySet<string>, kind: string, dropPrefix: boolean): NamePart[] {
  const parts: NamePart[] = name.split(/([-_.])/).map((p, i) => (i % 2 === 1 ? { text: p, kept: false, sep: true } : { text: p, kept: p !== "" && keepToken(p, words) }));
  const keptIdx = parts.flatMap((p, i) => (!p.sep && p.kept ? [i] : []));
  if (dropPrefix && keptIdx.length > 1 && (CAF_PREFIX[kind] ?? []).includes(parts[keptIdx[0]!]!.text.toLowerCase())) parts[keptIdx[0]!]!.kept = false;
  for (let i = 1; i < parts.length - 1; i += 2) parts[i]!.kept = parts[i - 1]!.kept && parts[i + 1]!.kept;
  return parts.filter((p) => p.text !== "");
}

/** Short name from the parts — kept words joined with "-" (what the card shows) */
export const partsText = (parts: readonly NamePart[]) => parts.filter((p) => p.kept && !p.sep).map((p) => p.text).join("-");

/** Every part kept (the short name is the full name) */
const allKept = (name: string): NamePart[] =>
  name.split(/([-_.])/).map((p, i) => (i % 2 === 1 ? { text: p, kept: true, sep: true } : { text: p, kept: true })).filter((p) => p.text !== "");

/**
 * Short names with their parts for the nodes of one view. `vnetOf(id)` names the VNet a node belongs to (its
 * own VNet for a ghost from another VNet). Names that would collide keep their type prefix; still colliding or
 * empty → the full name.
 */
export function shortNamesWithParts(
  nodes: ReadonlyArray<{ id: string; label: string; kind: string }>,
  vnetOf: (id: string) => string | undefined,
): Map<string, { text: string; parts: NamePart[] }> {
  const pass = (n: { id: string; label: string; kind: string }, dropPrefix: boolean) => {
    const v = vnetOf(n.id);
    const parts = v ? shortenParts(n.label, vnetWords(v), n.kind, dropPrefix) : allKept(n.label);
    return { text: v ? partsText(parts) : n.label, parts };
  };
  const count = (m: Map<string, { text: string }>) => {
    const c = new Map<string, number>();
    for (const v of m.values()) c.set(v.text, (c.get(v.text) ?? 0) + 1);
    return c;
  };
  const first = new Map(nodes.map((n) => [n.id, pass(n, true)] as const));
  const c1 = count(first);
  const second = new Map(nodes.map((n) => {
    const s = first.get(n.id)!;
    return [n.id, (c1.get(s.text) ?? 0) < 2 ? s : pass(n, false)] as const;
  }));
  const c2 = count(second);
  const out = new Map<string, { text: string; parts: NamePart[] }>();
  for (const n of nodes) {
    const s = second.get(n.id)!;
    out.set(n.id, !s.text || (c2.get(s.text) ?? 0) > 1 ? { text: n.label, parts: allKept(n.label) } : s);
  }
  return out;
}

/** Short names only (see shortNamesWithParts) */
export function shortNames(
  nodes: ReadonlyArray<{ id: string; label: string; kind: string }>,
  vnetOf: (id: string) => string | undefined,
): Map<string, string> {
  return new Map([...shortNamesWithParts(nodes, vnetOf)].map(([id, v]) => [id, v.text]));
}

/** "abcdefghij" → "abc…hij" when longer than `max` characters (keeps the distinguishing end) */
export function middleEllipsis(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return chars.slice(0, head).join("") + "…" + chars.slice(chars.length - (keep - head)).join("");
}
