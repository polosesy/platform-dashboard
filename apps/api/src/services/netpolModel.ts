// Network policies → one rule model (pure). Kubernetes NetworkPolicy and Cilium (Clusterwide)NetworkPolicy are enforced
// together by Cilium: a pod is in default-deny for a direction when any policy that isolates that direction selects it,
// and a connection passes when any rule of any selecting policy allows it — deny rules (Cilium) win over every allow.
// The web replays observed connections against this model (정책 시뮬레이션); the analyzer and the insights use
// `cnpIsolates` so a Cilium policy with `enableDefaultDeny: false` (an audit / observe-only policy) is never counted as
// isolation — it adds allows but blocks nothing.
import type { NetpolDirection, NetpolModel, NetpolPeer, NetpolPolicy, NetpolPort, NetpolRule, NetpolSelector } from "@aud/types";

type Obj = Record<string, unknown>;
type Dir = "ingress" | "egress";
type CiliumSpecLike = {
  endpointSelector?: NetpolSelector;
  ingress?: unknown[];
  ingressDeny?: unknown[];
  egress?: unknown[];
  egressDeny?: unknown[];
  enableDefaultDeny?: { ingress?: boolean; egress?: boolean };
};
type K8sPolicyLike = { namespace: string; name: string; podSelector: NetpolSelector; policyTypes?: string[]; ingress?: unknown[]; egress?: unknown[] };

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sel = (v: unknown): NetpolSelector => {
  const o = obj(v) ?? {};
  const ml = obj(o.matchLabels);
  const me = arr(o.matchExpressions).map(obj).filter((e): e is Obj => !!e && typeof e.key === "string" && typeof e.operator === "string");
  return {
    ...(ml ? { matchLabels: Object.fromEntries(Object.entries(ml).map(([k, x]) => [k, String(x)])) } : {}),
    ...(me.length ? { matchExpressions: me.map((e) => ({ key: String(e.key), operator: String(e.operator), ...(Array.isArray(e.values) ? { values: e.values.map(String) } : {}) })) } : {}),
  };
};

/** Cilium: a direction is default-deny when the spec has rules for it and `enableDefaultDeny` does not turn that off */
export function cnpIsolates(spec: CiliumSpecLike, dir: Dir): boolean {
  const has = dir === "ingress" ? spec.ingress !== undefined || spec.ingressDeny !== undefined : spec.egress !== undefined || spec.egressDeny !== undefined;
  return has && spec.enableDefaultDeny?.[dir] !== false;
}

/** Kubernetes: policyTypes, or Ingress (+ Egress when there are egress rules) when not set */
export function npTypes(np: { policyTypes?: string[]; egress?: unknown[] }): Array<"Ingress" | "Egress"> {
  const t = np.policyTypes?.length ? np.policyTypes : ["Ingress", ...(np.egress?.length ? ["Egress"] : [])];
  return t.filter((x): x is "Ingress" | "Egress" => x === "Ingress" || x === "Egress");
}

const proto = (p: unknown): NetpolPort["protocol"] => {
  const s = String(p ?? "TCP").toUpperCase();
  return s === "UDP" || s === "SCTP" || s === "ANY" ? s : "TCP";
};

function k8sPorts(ports: unknown): NetpolPort[] {
  return arr(ports).map(obj).filter((p): p is Obj => !!p).map((p) => ({
    protocol: proto(p.protocol),
    ...(p.port !== undefined && p.port !== null ? { port: String(p.port) } : {}),
    ...(typeof p.endPort === "number" ? { endPort: p.endPort } : {}),
  }));
}

function k8sPeer(p: Obj): NetpolPeer {
  const ip = obj(p.ipBlock);
  if (ip) return { kind: "cidr", cidr: String(ip.cidr ?? ""), ...(arr(ip.except ?? ip._except).length ? { except: arr(ip.except ?? ip._except).map(String) } : {}) };
  const nsSel = p.namespaceSelector !== undefined && p.namespaceSelector !== null ? sel(p.namespaceSelector) : null;
  const podSel = p.podSelector !== undefined && p.podSelector !== null ? sel(p.podSelector) : null;
  return { kind: "pods", ns: nsSel ?? "same", pods: podSel };
}

function k8sRules(rules: unknown[] | undefined, dir: Dir): NetpolRule[] {
  return (rules ?? []).map(obj).filter((r): r is Obj => !!r).map((r) => {
    const peers = arr(dir === "ingress" ? r.from ?? r._from : r.to).map(obj).filter((p): p is Obj => !!p);
    return { peers: peers.length ? peers.map(k8sPeer) : [{ kind: "any" }], ports: k8sPorts(r.ports) };
  });
}

export function normalizeK8sPolicy(np: K8sPolicyLike): NetpolPolicy {
  const types = npTypes(np);
  const dir = (d: Dir, t: "Ingress" | "Egress"): NetpolDirection | null =>
    types.includes(t) ? { isolates: true, rules: k8sRules(d === "ingress" ? np.ingress : np.egress, d) } : null;
  return {
    id: `kubernetes:${np.namespace}/${np.name}`, source: "kubernetes", name: np.name, namespace: np.namespace,
    selector: sel(np.podSelector), ingress: dir("ingress", "Ingress"), egress: dir("egress", "Egress"),
  };
}

const PEER_KEYS: Record<Dir, string[]> = {
  ingress: ["fromEndpoints", "fromCIDR", "fromCIDRSet", "fromEntities"],
  egress: ["toEndpoints", "toCIDR", "toCIDRSet", "toEntities", "toFQDNs"],
};
const UNSUPPORTED: Record<Dir, string[]> = {
  ingress: ["fromRequires", "fromGroups", "fromNodes", "icmps"],
  egress: ["toRequires", "toGroups", "toNodes", "toServices", "icmps"],
};

function ciliumRule(r: Obj, dir: Dir, clusterwide: boolean, deny: boolean): NetpolRule {
  const [ep, cidr, cidrSet, ent] = PEER_KEYS[dir];
  const peers: NetpolPeer[] = [
    ...arr(r[ep!]).map((s) => ({ kind: "endpoints" as const, selector: sel(s), clusterwide })),
    ...arr(r[cidr!]).map((c) => ({ kind: "cidr" as const, cidr: String(c) })),
    ...arr(r[cidrSet!]).map(obj).filter((c): c is Obj => !!c && typeof c.cidr === "string").map((c) => ({ kind: "cidr" as const, cidr: String(c.cidr), ...(arr(c.except).length ? { except: arr(c.except).map(String) } : {}) })),
    ...arr(r[ent!]).map((e) => ({ kind: "entity" as const, entity: String(e) })),
    ...(dir === "egress" ? arr(r.toFQDNs).map(obj).filter((f): f is Obj => !!f).map((f) => ({
      kind: "fqdn" as const, ...(typeof f.matchName === "string" ? { name: f.matchName } : {}), ...(typeof f.matchPattern === "string" ? { pattern: f.matchPattern } : {}),
    })) : []),
  ];
  const unsupported = UNSUPPORTED[dir].filter((k) => r[k] !== undefined);
  const toPorts = arr(r.toPorts).map(obj).filter((p): p is Obj => !!p);
  const ports: NetpolPort[] = toPorts.flatMap((tp) => arr(tp.ports).map(obj).filter((p): p is Obj => !!p).map((p) => ({
    protocol: proto(p.protocol),
    ...(p.port !== undefined && String(p.port) !== "0" ? { port: String(p.port) } : {}),
    ...(typeof p.endPort === "number" ? { endPort: p.endPort } : {}),
  })));
  const l7 = toPorts.some((tp) => { const rr = obj(tp.rules); return !!rr && Object.values(rr).some((v) => arr(v).length > 0); });
  // Only peers given = those peers; nothing but toPorts = every peer on those ports; nothing at all = every peer
  const anyPeer = !peers.length && !unsupported.length;
  return {
    peers: anyPeer ? [{ kind: "any" }] : peers, ports,
    ...(deny ? { deny: true } : {}), ...(l7 ? { l7: true } : {}), ...(unsupported.length ? { unsupported } : {}),
  };
}

export function normalizeCiliumPolicy(cp: { namespace?: string; name: string; specs: CiliumSpecLike[] }): NetpolPolicy[] {
  const clusterwide = cp.namespace === undefined;
  const source = clusterwide ? "cilium-clusterwide" : "cilium";
  return cp.specs.flatMap((s, i) => {
    if (!s.endpointSelector) return []; // host policies (nodeSelector) select no pod
    const dir = (d: Dir): NetpolDirection | null => {
      const allow = (d === "ingress" ? s.ingress : s.egress);
      const deny = (d === "ingress" ? s.ingressDeny : s.egressDeny);
      if (allow === undefined && deny === undefined) return null;
      const rules = [
        ...arr(allow).map(obj).filter((r): r is Obj => !!r).map((r) => ciliumRule(r, d, clusterwide, false)),
        ...arr(deny).map(obj).filter((r): r is Obj => !!r).map((r) => ciliumRule(r, d, clusterwide, true)),
      ];
      return { isolates: cnpIsolates(s, d), rules };
    };
    const name = cp.specs.length > 1 ? `${cp.name}[${i}]` : cp.name;
    return [{
      id: `${source}:${cp.namespace ?? ""}/${name}`, source, name, namespace: cp.namespace ?? "",
      selector: s.endpointSelector, ingress: dir("ingress"), egress: dir("egress"),
    } satisfies NetpolPolicy];
  });
}

export function buildNetpolModel(inv: {
  namespaces: Array<{ name: string; labels: Record<string, string> }>;
  workloads: Array<{ namespace: string; name: string; kind: string; podLabels: Record<string, string>; serviceAccountName?: string }>;
  networkPolicies: K8sPolicyLike[];
  ciliumPolicies: Array<{ namespace?: string; name: string; specs: CiliumSpecLike[] }>;
}, isSystem: (namespace: string, labels?: Record<string, string>) => boolean): NetpolModel {
  return {
    namespaces: inv.namespaces.map((n) => ({ name: n.name, labels: n.labels, system: isSystem(n.name) })),
    workloads: inv.workloads.map((w) => ({ id: `${w.namespace}/${w.name}`, namespace: w.namespace, name: w.name, kind: w.kind, labels: w.podLabels, serviceAccount: w.serviceAccountName ?? "default", system: isSystem(w.namespace, w.podLabels) })),
    policies: [...inv.networkPolicies.map(normalizeK8sPolicy), ...inv.ciliumPolicies.flatMap(normalizeCiliumPolicy)],
  };
}
