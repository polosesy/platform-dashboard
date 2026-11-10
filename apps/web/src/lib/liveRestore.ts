// Live diagram: which diagram to show on the next visit, and what to do when it is gone.
//
// The API keeps generated diagrams in memory, and a generated id is fixed per subscription (`auto-<first 8>`).
// So after a restart (every deploy) the remembered id answers 404 — and pressing "generate" returns the SAME id.
// Two rules follow (2026-11-11, stg: generate 201 · spec 200 six times, yet the page stayed empty):
//  1. Every generate is a new load (`rev`): the query key carries it, so an earlier 404 for that id is never read
//     as the answer to the new request (the old error belonged to the key `diagram-spec:<id>`, and the new request
//     had the same key — the page saw the old 404 and emptied itself before the new answer came).
//  2. Remember the subscription with the id: a gone diagram is generated again for it, once — not an empty page.

export const LAST_DIAGRAM_KEY = "aud.liveDiagram.last";

export type LastDiagram = { id: string; subscriptionId?: string };

/** Stored value → last diagram. Older pages stored the bare id (still read). */
export function parseLastDiagram(raw: string | null | undefined): LastDiagram | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && typeof (v as LastDiagram).id === "string" && (v as LastDiagram).id) {
        const sub = (v as LastDiagram).subscriptionId;
        return { id: (v as LastDiagram).id, ...(typeof sub === "string" && sub ? { subscriptionId: sub } : {}) };
      }
    } catch {
      /* not ours — treat as nothing remembered */
    }
    return null;
  }
  return { id: text };
}

export function serializeLastDiagram(d: LastDiagram): string {
  return JSON.stringify(d.subscriptionId ? { id: d.id, subscriptionId: d.subscriptionId } : { id: d.id });
}

/**
 * The remembered diagram answered 404. Generate it again for the same subscription (once per page visit), or show the
 * empty page. Only generated diagrams (`auto-…`) with a known subscription are regenerated — never the example, never
 * a guess.
 */
export function onMissingDiagram(last: LastDiagram | null, missingId: string, alreadyTried: boolean): "regenerate" | "empty" {
  if (alreadyTried || !last || last.id !== missingId) return "empty";
  if (!last.id.startsWith("auto-") || !last.subscriptionId) return "empty";
  return "regenerate";
}

/** Query key of one load of a diagram: the id plus the load number (a new generate = a new load, even for the same id) */
export function diagramLoadKey(id: string, rev: number): string | null {
  return id ? `${id}#${rev}` : null;
}
