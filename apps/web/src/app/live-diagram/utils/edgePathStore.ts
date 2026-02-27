// ── Edge Path Store ──
//
// Module-level registry that stores the actual SVG path `d` strings
// rendered by ReactFlow's AnimatedEdge component.
// D3ParticleCanvas reads from this store to ensure pixel-perfect
// particle alignment with the rendered edges.

const store = new Map<string, string>();

export function setEdgePath(edgeId: string, pathD: string): void {
  store.set(edgeId, pathD);
}

export function getEdgePath(edgeId: string): string | undefined {
  return store.get(edgeId);
}

export function clearEdgePaths(): void {
  store.clear();
}

export function getAllEdgePaths(): ReadonlyMap<string, string> {
  return store;
}
