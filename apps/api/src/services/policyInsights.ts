import type {
  AttackEdge,
  AttackNode,
  ClusterContainment,
  ComboType,
  EvidenceKind,
  ExternalIpDetail,
  FactRow,
  HubbleEndpoint,
  HubbleFlow,
  HubbleFlowSet,
  Kbom,
  KbomItem,
  KubernetesPolicyResponse,
  NetEdge,
  NetEdgeClass,
  NetNode,
  NetworkInsight,
  PolicyFinding,
  PolicyInsightsResponse,
  RbacMatrixRow,
  RbacRiskDef,
  RbacRiskKey,
  RemediationAction,
  RiskFactorDef,
  RiskFactorKey,
  RiskIssue,
  RiskWeight,
  WorkloadRiskRow,
} from "@aud/types";
import { L } from "../infra/lang.js";
import { selectorMatches, type InvRbacRule, type InvWorkload, type PolicyInventory } from "./policyAnalyzer.js";

// ──────────────────────────────────────────────────────────────
// Policy insights (pure)
//
// Turns the policy inventory, the policy check, observed Hubble flows
// and Azure context into: a workload × risk-factor matrix, toxic
// combinations with an evidence-graded attack path, an RBAC matrix,
// a workload network model and a KBOM. No I/O — every input is passed in.
// ──────────────────────────────────────────────────────────────

/** Azure endpoint that answered on a public IP (built by azureEndpoints.ts). */
export type AzureEndpoint = {
  name: string;
  type: string;
  typeLabel: string;
  /** Full ARM type, lowercase ("microsoft.keyvault/vaults") — `type` alone collides across providers */
  armType?: string;
  resourceGroup: string;
  host: string;
  publicAccess: string | null;
  ips: string[];
};

export type InsightsInput = {
  clusterId: string;
  inventory: PolicyInventory;
  policy: KubernetesPolicyResponse;
  /** null when Hubble is disabled or unreachable */
  flows: HubbleFlowSet | null;
  flowsError?: string;
  azure: { available: boolean; endpoints: AzureEndpoint[]; apiServerIps: string[] };
  containment: ClusterContainment;
  gaps: string[];
  now?: Date;
};

// Labels are built per call: the response language is chosen per request (see infra/lang.ts)
export const factors = (): RiskFactorDef[] => [
  { key: "exposure", label: L("외부 노출", "External exposure"), group: L("노출", "Exposure"), ev: "cfg", weight: "warn", desc: L("LoadBalancer · NodePort · Ingress · HTTPRoute 백엔드 (공인 노출은 장악·탈출 직결로 색칠)", "LoadBalancer · NodePort · Ingress · HTTPRoute backend (public exposure is coloured as takeover/escape)") },
  { key: "root", label: L("root 실행 가능", "May run as root"), group: L("실행", "Runtime"), ev: "cfg", weight: "low", desc: L("runAsNonRoot·runAsUser(>0) 미지정", "runAsNonRoot / runAsUser(>0) not set") },
  { key: "privEsc", label: L("권한 상승 허용", "Privilege escalation allowed"), group: L("실행", "Runtime"), ev: "cfg", weight: "low", desc: "allowPrivilegeEscalation ≠ false" },
  { key: "host", label: L("호스트 접근", "Host access"), group: L("실행", "Runtime"), ev: "cfg", weight: "crit", desc: L("privileged · hostNetwork/PID/IPC · hostPath · 추가 capability", "privileged · hostNetwork/PID/IPC · hostPath · added capabilities") },
  { key: "automount", label: L("SA 토큰 마운트", "SA token mounted"), group: L("신원", "Identity"), ev: "cfg", weight: "low", desc: L("pod spec automountServiceAccountToken ≠ false (ServiceAccount 기본값은 미수집)", "pod spec automountServiceAccountToken ≠ false (ServiceAccount defaults not collected)") },
  { key: "highRbac", label: L("고권한 RBAC", "High-privilege RBAC"), group: L("신원", "Identity"), ev: "perm", weight: "crit", desc: L("Secret 조회 · nodes/proxy · exec · bind/escalate · 토큰 발급 등 (가장 높은 권한의 등급으로 색칠)", "Secret read · nodes/proxy · exec · bind/escalate · token creation … (coloured by the highest grade)") },
  { key: "secret", label: L("Secret 사용", "Uses Secrets"), group: L("신원", "Identity"), ev: "cfg", weight: "warn", desc: L("Secret 볼륨 · envFrom · secretKeyRef", "Secret volume · envFrom · secretKeyRef") },
  { key: "noIngress", label: L("수신 격리 없음", "No ingress isolation"), group: L("네트워크", "Network"), ev: "cfg", weight: "warn", desc: L("이 파드를 고르는 Ingress 정책 0 (NetworkPolicy·CiliumNetworkPolicy)", "0 Ingress policies select this pod (NetworkPolicy · CiliumNetworkPolicy)") },
  { key: "noEgress", label: L("송신 제한 없음", "No egress limit"), group: L("네트워크", "Network"), ev: "cfg", weight: "warn", desc: L("이 파드를 고르는 Egress 정책 0", "0 Egress policies select this pod") },
  { key: "extEgress", label: L("클러스터 밖 송신", "Egress outside the cluster"), group: L("네트워크", "Network"), ev: "obs", weight: "warn", desc: L("Hubble 관측 — Azure PaaS · 인터넷 (API server 제외)", "Observed by Hubble — Azure PaaS · internet (API server excluded)") },
  { key: "psa", label: L("PSA 미적용", "No PSA"), group: "NS", ev: "cfg", weight: "low", desc: L("enforce 라벨 없음 또는 privileged", "No enforce label, or privileged") },
];

export const riskDict = (): RbacRiskDef[] => [
  { key: "clusterAdmin", label: "cluster-admin", raw: L("roleRef cluster-admin 또는 */*/*", "roleRef cluster-admin or */*/*"), grade: "crit" },
  { key: "escalate", label: "bind·escalate", raw: L("roles/clusterroles: bind 또는 escalate", "roles/clusterroles: bind or escalate"), grade: "crit" },
  { key: "impersonate", label: "impersonate", raw: "users/groups/serviceaccounts: impersonate", grade: "crit" },
  { key: "webhook", label: L("Webhook 변경", "Webhook changes"), raw: "validating/mutatingwebhookconfigurations: create/update/patch/delete", grade: "crit" },
  { key: "nodesProxy", label: "nodes/proxy", raw: L("nodes/proxy: get/create (kubelet API — websocket exec 가능)", "nodes/proxy: get/create (kubelet API — websocket exec possible)"), grade: "crit" },
  { key: "wildcard", label: L("리소스 와일드카드", "Resource wildcard"), raw: L("resources: * 또는 verbs: *", "resources: * or verbs: *"), grade: "warn" },
  { key: "secrets", label: L("Secret 조회", "Secret read"), raw: "secrets: get/list/watch", grade: "warn" },
  { key: "exec", label: "pods/exec·attach", raw: L("pods/exec, pods/attach: create (get만 있으면 조건부)", "pods/exec, pods/attach: create (conditional with get only)"), grade: "warn" },
  { key: "token", label: L("SA 토큰 발급", "SA token creation"), raw: "serviceaccounts/token: create", grade: "warn" },
  { key: "csr", label: L("CSR 승인", "CSR approval"), raw: "certificatesigningrequests/approval: update/patch", grade: "warn" },
  { key: "pv", label: L("PV 생성", "PV creation"), raw: "persistentvolumes: create", grade: "warn" },
  { key: "ns", label: L("Namespace 수정", "Namespace changes"), raw: "namespaces: update/patch", grade: "warn" },
];
export const GRADE = Object.fromEntries(riskDict().map((r) => [r.key, r.grade])) as Record<RbacRiskKey, "crit" | "warn">;
const riskLabel = (k: RbacRiskKey): string => riskDict().find((r) => r.key === k)?.label ?? k;
const WEIGHT_SCORE: Record<RiskWeight, number> = { crit: 3, warn: 2, low: 1 };

// ── Small helpers ──

const wid = (w: { namespace: string; name: string }) => `${w.namespace}/${w.name}`;

export function isAksManaged(labels: Record<string, string> | undefined): boolean {
  return !!labels && (labels["kubernetes.azure.com/managedby"] === "aks" || "addonmanager.kubernetes.io/mode" in labels);
}

function ownerOf(w: InvWorkload): string {
  if (isAksManaged(w.labels)) return L("AKS 관리", "AKS managed");
  const chart = w.labels?.["helm.sh/chart"];
  if (chart) return `Helm ${chart}`;
  if (w.helmRelease) return `Helm ${w.helmRelease}`;
  if (w.labels?.["app.kubernetes.io/managed-by"] === "Helm") return "Helm";
  return L("kubectl·기타", "kubectl / other");
}

function has(list: string[] | undefined, ...values: string[]): boolean {
  return !!list && (list.includes("*") || values.some((v) => list.includes(v)));
}
function grants(rule: InvRbacRule, resources: string[], verbs: string[]): boolean {
  if (rule.resourceNames?.length) return false;
  return has(rule.resources, ...resources) && has(rule.verbs, ...verbs);
}

/** RBAC risk keys of a role's rules (same verb semantics as the policy analyzer). */
export function rbacRiskKeys(rules: InvRbacRule[], roleName: string): { keys: RbacRiskKey[]; conditional: RbacRiskKey[]; rules: string[] } {
  const keys = new Set<RbacRiskKey>();
  const cond = new Set<RbacRiskKey>();
  const hit = new Set<string>();
  const mark = (k: RbacRiskKey, rule: InvRbacRule) => {
    keys.add(k);
    hit.add(`${(rule.resources ?? []).join(",")}:${rule.verbs.join(",")}`);
  };
  if (roleName === "cluster-admin") keys.add("clusterAdmin");
  for (const r of rules) {
    if (!r.resources?.length) continue;
    const allRes = r.resources.includes("*"), allVerbs = r.verbs.includes("*");
    if (allRes && allVerbs && (r.apiGroups ?? []).includes("*")) mark("clusterAdmin", r);
    else if (allRes || allVerbs) mark("wildcard", r);
    if (grants(r, ["roles", "clusterroles"], ["bind", "escalate"])) mark("escalate", r);
    if (grants(r, ["users", "groups", "serviceaccounts", "uids"], ["impersonate"])) mark("impersonate", r);
    if (grants(r, ["validatingwebhookconfigurations", "mutatingwebhookconfigurations"], ["create", "update", "patch", "delete"])) mark("webhook", r);
    if (grants(r, ["nodes/proxy"], ["get", "create"])) mark("nodesProxy", r);
    if (grants(r, ["secrets"], ["get", "list", "watch"])) mark("secrets", r);
    if (grants(r, ["pods/exec", "pods/attach"], ["create"])) mark("exec", r);
    else if (grants(r, ["pods/exec", "pods/attach"], ["get"])) { mark("exec", r); cond.add("exec"); }
    if (grants(r, ["serviceaccounts/token"], ["create"])) mark("token", r);
    if (grants(r, ["certificatesigningrequests/approval"], ["update", "patch"])) mark("csr", r);
    if (grants(r, ["persistentvolumes"], ["create"])) mark("pv", r);
    if (grants(r, ["namespaces"], ["update", "patch"])) mark("ns", r);
  }
  // A confirmed grant from another rule wins over the conditional one
  if (cond.has("exec") && rules.some((r) => grants(r, ["pods/exec", "pods/attach"], ["create"]))) cond.delete("exec");
  // cluster-admin already implies every other risk — listing them all only adds noise
  if (keys.has("clusterAdmin")) return { keys: ["clusterAdmin"], conditional: [], rules: [...hit].slice(0, 1).concat(roleName === "cluster-admin" ? ["roleRef: cluster-admin"] : []) };
  const order = riskDict().map((d) => d.key);
  return { keys: [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)), conditional: [...cond], rules: [...hit] };
}

export function roleRules(inv: PolicyInventory, roleRef: { kind: string; name: string }, namespace?: string): InvRbacRule[] {
  const role = inv.roles.find((r) => r.kind === roleRef.kind && r.name === roleRef.name && (roleRef.kind === "ClusterRole" || r.namespace === namespace));
  return role?.rules ?? [];
}

/** Bindings whose subjects include the service account. */
function saBindings(inv: PolicyInventory, ns: string, sa: string) {
  return inv.bindings.filter((b) => b.subjects.some((s) => s.kind === "ServiceAccount" && s.name === sa && (s.namespace ?? b.namespace) === ns));
}

// ── Network policy selection per workload ──

function policySelection(inv: PolicyInventory, w: InvWorkload): { ingress: string[]; egress: string[] } {
  const ingress: string[] = [], egress: string[] = [];
  for (const np of inv.networkPolicies) {
    if (np.namespace !== w.namespace || !selectorMatches(np.podSelector, w.podLabels, w.namespace)) continue;
    const types = np.policyTypes ?? (np.egress ? ["Ingress", "Egress"] : ["Ingress"]);
    if (types.includes("Ingress")) ingress.push(np.name);
    if (types.includes("Egress")) egress.push(np.name);
  }
  for (const cp of inv.ciliumPolicies) {
    if (cp.namespace !== undefined && cp.namespace !== w.namespace) continue;
    for (const s of cp.specs) {
      if (!s.endpointSelector || !selectorMatches(s.endpointSelector, w.podLabels, w.namespace)) continue;
      if (s.ingress || s.ingressDeny) ingress.push(cp.name);
      if (s.egress || s.egressDeny) egress.push(cp.name);
    }
  }
  return { ingress: [...new Set(ingress)], egress: [...new Set(egress)] };
}

function exposureOf(inv: PolicyInventory, w: InvWorkload): { text: string[]; public: boolean; services: string[] } {
  const svcs = (inv.services ?? []).filter((s) => s.namespace === w.namespace && Object.keys(s.selector).length && selectorMatches({ matchLabels: s.selector }, w.podLabels, w.namespace));
  const text: string[] = [];
  let pub = false;
  for (const s of svcs) {
    if (s.type === "LoadBalancer") { text.push(L(`${s.internal ? "내부" : "공인"} LB ${s.name}`, `${s.internal ? "Internal" : "Public"} LB ${s.name}`)); if (!s.internal) pub = true; }
    if (s.type === "NodePort") { text.push(`NodePort ${s.name}`); pub = true; }
  }
  const names = new Set(svcs.map((s) => s.name));
  for (const r of inv.routes ?? []) {
    if (r.namespace === w.namespace && r.backends.some((b) => names.has(b))) { text.push(`${r.kind} ${r.name}`); pub = true; }
  }
  return { text, public: pub, services: svcs.map((s) => `${s.name} (${s.type} ${s.ports.join(",")})`) };
}

// ── Network model from Hubble flows ──

const IMDS = "169.254.169.254";
const WIRESERVER = "168.63.129.16";

type Resolver = (ep: HubbleEndpoint, ip: string | undefined, dir: "src" | "dst", peer?: string) => string | null;

/**
 * Several Azure resources can answer on one front-end IP (storage stamps). Prefer the
 * cluster's resource group, then a name that contains the calling workload's name.
 */
export function pickAzureEndpoint(cands: AzureEndpoint[], clusterRg: string, peer: string | undefined): AzureEndpoint | undefined {
  if (cands.length <= 1) return cands[0];
  const token = (peer ?? "").split("/").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const score = (a: AzureEndpoint) =>
    (a.resourceGroup.toLowerCase() === clusterRg.toLowerCase() ? 2 : 0) +
    (token.length >= 3 && a.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(token) ? 3 : 0);
  return [...cands].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
}

function makeResolver(workloads: InvWorkload[], input: InsightsInput): { resolve: Resolver } {
  const azureByIp = new Map<string, AzureEndpoint[]>();
  for (const a of input.azure.endpoints) for (const ip of a.ips) azureByIp.set(ip, [...(azureByIp.get(ip) ?? []), a]);
  const apiIps = new Set(input.azure.apiServerIps);
  const byNs = new Map<string, InvWorkload[]>();
  for (const w of workloads) byNs.set(w.namespace, [...(byNs.get(w.namespace) ?? []), w]);
  const memo = new Map<string, string>();
  const resolve: Resolver = (ep, ip, dir, peer) => {
    if (ep.namespace) {
      const key = `${ep.namespace}|${ep.podName}|${ep.workloadName}|${ep.identity}`;
      const hit = memo.get(key);
      if (hit) return hit;
      const labels = Object.fromEntries(Object.entries(ep.labels).map(([k, v]) => [k.replace(/^k8s:/, ""), v]));
      // Most specific template selector that matches the pod's labels
      const cands = (byNs.get(ep.namespace) ?? []).filter((w) => Object.keys(w.podLabels).length && selectorMatches({ matchLabels: w.podLabels }, labels, ep.namespace));
      cands.sort((a, b) => Object.keys(b.podLabels).length - Object.keys(a.podLabels).length);
      const id = cands[0] ? wid(cands[0]) : `${ep.namespace}/${ep.workloadName || ep.podName}`;
      memo.set(key, id);
      return id;
    }
    const name = ep.workloadName;
    if (name === "host") return "ext:host";
    if (name === "remote-node") return "ext:remote-node";
    if (name === "kube-apiserver" || (ip && apiIps.has(ip))) return "apiserver";
    if (ip === WIRESERVER) return dir === "src" ? "probe:lb" : "platform:wireserver";
    if (ip === IMDS) return "platform:imds";
    if (name === "world") {
      const az = ip ? pickAzureEndpoint(azureByIp.get(ip) ?? [], input.containment.resourceGroup, peer) : undefined;
      return az ? `azure:${az.type}/${az.name}` : "ext:world";
    }
    return "ext:unknown";
  };
  return { resolve };
}

export function buildNetwork(input: InsightsInput, workloads: InvWorkload[], rowById: Map<string, WorkloadRiskRow>): NetworkInsight {
  const empty = (reason: string): NetworkInsight => ({ available: false, reason, coverage: input.flows?.coverage ?? null, nodes: [], edges: [], unmatchedExternal: [], azureMatched: input.azure.available });
  if (!input.flows) return empty(input.flowsError ?? L("Hubble 관측 데이터 없음", "No Hubble flow data"));
  if (input.flows.flows.length === 0) return empty(L("관측 구간 동안 수집된 flow가 없습니다", "No flows were collected in the observed window"));
  const { resolve } = makeResolver(workloads, input);
  const edges = new Map<string, NetEdge & { portSet: Set<string> }>();
  const ext = new Map<string, { ports: Set<number>; count: number; from: Set<string> }>();
  const kindOf = (id: string): NetNode["kind"] =>
    id.startsWith("azure:") ? "paas" : id === "apiserver" ? "apiserver" : id === "ext:world" ? "internet"
      : id === "ext:host" || id === "ext:remote-node" ? "node" : id === "probe:lb" ? "probe" : id.startsWith("platform:") ? "platform"
        : id === "ext:unknown" ? "unknown" : "workload";
  const port = (f: HubbleFlow) => (f.l4Protocol === "ICMP" ? "ICMP" : f.l4Protocol === "UDP" ? `udp/${f.destinationPort}` : String(f.destinationPort));
  for (const f of input.flows.flows) {
    if (f.isReply) continue;
    const from = resolve(f.source, f.sourceIp, "src");
    const to = resolve(f.destination, f.destinationIp, "dst", from ?? undefined);
    if (!from || !to || from === to) continue;
    const kf = kindOf(from), kt = kindOf(to);
    if (kf !== "workload" && kt !== "workload") continue; // node ↔ platform noise
    const tunnel = from === "kube-system/konnectivity-agent" && kt === "node";
    const cls: NetEdgeClass = tunnel ? "control"
      : kf === "probe" || kt === "platform" || kf === "node" || kt === "node" || kt === "unknown" || kf === "unknown" ? "platform"
        : kt === "paas" ? "cloud" : kt === "apiserver" ? "control" : kt === "internet" ? "internet" : "eastwest";
    const k = `${from}>${to}`;
    const e = edges.get(k) ?? { from, to, ports: [], portSet: new Set<string>(), count: 0, dropped: 0, cls, ...(tunnel ? { note: L("컨트롤 플레인 터널(exec/logs 경로)", "Control-plane tunnel (exec/logs path)") } : {}) };
    e.portSet.add(port(f));
    e.count++;
    if (f.verdict === "DROPPED") e.dropped++;
    edges.set(k, e);
    if (to === "ext:world" && f.destinationIp) {
      const x = ext.get(f.destinationIp) ?? { ports: new Set<number>(), count: 0, from: new Set<string>() };
      x.ports.add(f.destinationPort); x.count++; x.from.add(from);
      ext.set(f.destinationIp, x);
    }
  }
  const portNum = (p: string) => (p === "ICMP" ? -1 : Number(p.replace(/\D/g, "")));
  const outEdges: NetEdge[] = [...edges.values()].map(({ portSet, ...e }) => ({ ...e, ports: [...portSet].sort((a, b) => portNum(a) - portNum(b)) }))
    .sort((a, b) => b.count - a.count);
  const ids = new Set(outEdges.flatMap((e) => [e.from, e.to]));
  const azureById = new Map(input.azure.endpoints.map((a) => [`azure:${a.type}/${a.name}`, a]));
  const nodes: NetNode[] = [...ids].map((id) => {
    const kind = kindOf(id);
    if (kind === "workload") {
      const r = rowById.get(id);
      const [ns, name] = [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];
      return { id, kind, namespace: ns, label: r?.name ?? name, sub: r ? `${r.kind} ×${r.pods}` : L("워크로드(컨트롤러 미식별)", "Workload (controller not identified)"), managed: r?.managed ?? isAksManaged(undefined), combos: r?.combos.map((c) => c.type) ?? [] };
    }
    if (kind === "paas") {
      const a = azureById.get(id)!;
      const shared = input.azure.endpoints.filter((o) => o !== a && o.ips.some((ip) => a.ips.includes(ip))).map((o) => o.name);
      return {
        id, kind, label: a.name, sub: L(`${a.typeLabel} · 공용 액세스 ${a.publicAccess === "Enabled" ? "켜짐" : a.publicAccess === "Disabled" ? "꺼짐" : "?"}`, `${a.typeLabel} · public access ${a.publicAccess === "Enabled" ? "on" : a.publicAccess === "Disabled" ? "off" : "?"}`),
        azureType: a.typeLabel, publicAccess: a.publicAccess, host: a.host, ips: a.ips, ...(shared.length ? { sharedIpWith: shared } : {}),
      };
    }
    const fixed: Record<string, [string, string]> = {
      apiserver: ["AKS API server", "kube-apiserver :443"],
      "ext:world": [L("인터넷 · 미식별", "Internet · unidentified"), L("Azure 리소스로 매칭 안 됨", "Not matched to an Azure resource")],
      "ext:host": [L("노드 (host)", "Node (host)"), L("노드 프로세스 · hostNetwork 파드", "Node processes · hostNetwork pods")],
      "ext:remote-node": [L("다른 노드 (remote-node)", "Other node (remote-node)"), L("다른 노드 · SNAT된 LB 트래픽 포함", "Other nodes · includes SNAT-ed LB traffic")],
      "probe:lb": [L("Azure LB 헬스 프로브", "Azure LB health probe"), WIRESERVER],
      "platform:wireserver": ["Azure WireServer/DNS", WIRESERVER],
      "platform:imds": ["Azure IMDS", L(`${IMDS} (메타데이터·토큰)`, `${IMDS} (metadata · tokens)`)],
      "ext:unknown": [L("식별 불가 대상", "Unidentified destination"), L("Hubble identity 미해석", "Hubble identity not resolved")],
    };
    const [label, sub] = fixed[id] ?? [id, ""];
    return { id, kind, label, sub };
  });
  const unmatchedExternal: ExternalIpDetail[] = [...ext.entries()]
    .map(([ip, v]) => ({ ip, ports: [...v.ports].sort((a, b) => a - b), count: v.count, from: [...v.from] }))
    .sort((a, b) => b.count - a.count);
  return { available: true, coverage: input.flows.coverage, nodes, edges: outEdges, unmatchedExternal, azureMatched: input.azure.available };
}

// ── KBOM ──

const KBOM_CATS: Array<[string, string, RegExp]> = [
  ["네트워킹 · Cilium", "Networking · Cilium", /cilium|hubble|containernetworking|ip-masq|apiserver-network-proxy|retina|konnectivity/],
  ["인그레스", "Ingress", /application-lb|ingress|gateway|nginx|traefik|envoy/],
  ["관측", "Observability", /grafana|loki|tempo|pyroscope|alloy|kube-state-metrics|node-exporter|containerinsights|metrics-server|prometheus|k8s-sidecar|otel|opentelemetry/],
  ["보안 · 신원", "Security · identity", /workload-identity|addon-token-adapter|gatekeeper|policy|cert-manager|secrets-store/],
  ["스토리지", "Storage", /csi/],
  ["DNS · 스케일링", "DNS · scaling", /coredns|autoscaler|addon-resizer|cloud-node-manager|keda/],
];
const kbomCategory = (repo: string): string => {
  const c = KBOM_CATS.find(([, , re]) => re.test(repo));
  return c ? L(c[0], c[1]) : L("애플리케이션", "Applications");
};
const PUBLIC_REGISTRIES = new Set(["docker.io", "quay.io", "registry.k8s.io", "ghcr.io", "gcr.io", "public.ecr.aws"]);

export function parseImage(image: string): { repo: string; registry: string; tag: string; digest: boolean } {
  const [noDigest, digestPart] = image.split("@");
  const last = noDigest!.lastIndexOf(":");
  const hasTag = last > noDigest!.lastIndexOf("/");
  const repo = hasTag ? noDigest!.slice(0, last) : noDigest!;
  const first = repo.split("/")[0]!;
  const registry = repo.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first : "docker.io";
  return { repo, registry, tag: hasTag ? noDigest!.slice(last + 1) : digestPart ? "(digest)" : "latest", digest: !!digestPart };
}

export function buildKbom(workloads: InvWorkload[], input: InsightsInput): Kbom {
  const items = new Map<string, KbomItem & { tagSet: Set<string>; digestAll: boolean }>();
  for (const w of workloads) {
    for (const c of w.security?.containers ?? []) {
      if (!c.image) continue;
      const p = parseImage(c.image);
      const it = items.get(p.repo) ?? {
        tech: p.repo.split("/").pop()!, repo: p.repo, registry: p.registry, versions: [], workloads: [], managed: true,
        category: kbomCategory(p.repo), flags: [], tagSet: new Set<string>(), digestAll: true,
      };
      it.tagSet.add(p.tag);
      if (!it.workloads.includes(wid(w))) it.workloads.push(wid(w));
      if (!isAksManaged(w.labels)) it.managed = false;
      if (!p.digest) it.digestAll = false;
      items.set(p.repo, it);
    }
  }
  const list: KbomItem[] = [...items.values()].map(({ tagSet, digestAll, ...it }) => {
    const versions = [...tagSet].sort();
    const flags: KbomItem["flags"] = [];
    if (versions.length > 1) flags.push({ key: "drift", label: L(`버전 ${versions.length}개 혼재`, `${versions.length} versions mixed`) });
    if (versions.some((v) => /snapshot|latest|dev$|^main$|^master$/i.test(v))) flags.push({ key: "snapshot", label: L("비릴리스 태그", "Non-release tag") });
    if (PUBLIC_REGISTRIES.has(it.registry)) flags.push({ key: "public", label: L("공개 레지스트리 직접 pull", "Pulled directly from a public registry") });
    void digestAll;
    return { ...it, versions, flags };
  }).sort((a, b) => a.category.localeCompare(b.category) || Number(a.managed) - Number(b.managed) || a.tech.localeCompare(b.tech));
  const pinned = [...items.values()].filter((i) => i.digestAll).length;
  const nodes = input.inventory.nodes ?? [];
  const same = (k: keyof (typeof nodes)[number]) => new Set(nodes.map((n) => n[k])).size <= 1;
  const n0 = nodes[0];
  const c = input.containment.cluster;
  const platform: Kbom["platform"] = [
    { label: "Kubernetes", value: c.k8sVersion ? `v${c.k8sVersion.replace(/^v/, "")}` : "?", note: L("컨트롤 플레인", "Control plane") },
    ...(n0 ? [
      { label: L("노드 이미지", "Node image"), value: n0.nodeImage ?? "?", note: same("nodeImage") ? L(`${nodes.length}/${nodes.length} 노드 동일`, `Same on ${nodes.length}/${nodes.length} nodes`) : L("노드 간 상이", "Differs between nodes") },
      { label: L("노드 OS · 커널", "Node OS · kernel"), value: `${n0.osImage ?? "?"} · ${n0.kernel ?? "?"}`, note: same("kernel") ? L("전 노드 동일", "Same on all nodes") : L("노드 간 상이", "Differs between nodes") },
      { label: L("컨테이너 런타임", "Container runtime"), value: (n0.runtime ?? "?").replace("containerd://", "containerd "), note: same("runtime") ? L("전 노드 동일", "Same on all nodes") : L("노드 간 상이", "Differs between nodes") },
      { label: "kubelet", value: n0.kubelet ?? "?", note: same("kubelet") ? (c.k8sVersion && n0.kubelet?.replace(/^v/, "") === c.k8sVersion.replace(/^v/, "") ? L("컨트롤 플레인과 일치", "Matches the control plane") : L("전 노드 동일", "Same on all nodes")) : L("노드 간 버전 차이", "Versions differ between nodes") },
      { label: L("노드 풀", "Node pools"), value: [...new Set(nodes.map((n) => `${n.pool ?? "?"} · ${n.vmSize ?? "?"}`))].map((p) => `${p} ×${nodes.filter((n) => `${n.pool ?? "?"} · ${n.vmSize ?? "?"}` === p).length}`).join(", "), note: "" },
    ] : []),
  ];
  return {
    platform,
    items: list,
    summary: {
      images: list.length,
      registries: [...new Set(list.map((i) => i.registry))].sort(),
      drift: list.filter((i) => i.flags.some((f) => f.key === "drift")).length,
      snapshot: list.filter((i) => i.flags.some((f) => f.key === "snapshot")).length,
      publicPull: list.filter((i) => i.flags.some((f) => f.key === "public")).length,
      digestPinned: pinned,
    },
  };
}

// ── Workload risk rows ──

type RowCtx = { row: WorkloadRiskRow; w: InvWorkload; sel: { ingress: string[]; egress: string[] }; exposure: ReturnType<typeof exposureOf>; rbac: Array<{ binding: string; kind: string; role: string; keys: RbacRiskKey[]; conditional: RbacRiskKey[]; rules: string[] }> };

function buildRows(input: InsightsInput, workloads: InvWorkload[]): RowCtx[] {
  const { inventory: inv, policy } = input;
  const psaOf = new Map(policy.namespaces.map((n) => [n.name, n]));
  return workloads.map((w) => {
    const sec = w.security;
    const sa = w.serviceAccountName ?? "default";
    const sel = policySelection(inv, w);
    const exposure = exposureOf(inv, w);
    const rbac = saBindings(inv, w.namespace, sa).map((b) => {
      const r = rbacRiskKeys(roleRules(inv, b.roleRef, b.namespace), b.roleRef.name);
      return { binding: b.name, kind: b.kind, role: b.roleRef.name, ...r };
    }).filter((b) => b.keys.length);
    const containers = (sec?.containers ?? []).filter((c) => !c.init);
    const nonRoot = (x: { runAsNonRoot?: boolean; runAsUser?: number }) => x.runAsNonRoot === true || (x.runAsUser ?? -1) > 0;
    const cells: WorkloadRiskRow["cells"] = {};
    const weights: WorkloadRiskRow["weights"] = {};
    if (exposure.text.length) { cells.exposure = exposure.text.join(" · "); weights.exposure = exposure.public ? "crit" : "warn"; }
    if (sec && !(nonRoot(sec) || (containers.length > 0 && containers.every(nonRoot)))) cells.root = L("runAsNonRoot·runAsUser 미지정", "runAsNonRoot / runAsUser not set");
    if (sec && containers.some((c) => c.allowPrivilegeEscalation !== false || c.privileged)) cells.privEsc = L("allowPrivilegeEscalation 미차단", "allowPrivilegeEscalation not blocked");
    const caps = [...new Set((sec?.containers ?? []).flatMap((c) => c.capAdd).filter((c) => c !== "NET_BIND_SERVICE"))];
    const host = [
      (sec?.containers ?? []).some((c) => c.privileged) && "privileged",
      sec?.hostNetwork && "hostNetwork",
      sec?.hostPID && "hostPID",
      sec?.hostIPC && "hostIPC",
      sec?.hostPaths.length && `hostPath ${sec.hostPaths.slice(0, 2).join(", ")}${sec.hostPaths.length > 2 ? " …" : ""}`,
      caps.length && `cap ${caps.join(",")}`,
    ].filter(Boolean);
    if (host.length) cells.host = host.join(" · ");
    if (w.automountServiceAccountToken !== false) cells.automount = `SA ${sa}`;
    if (rbac.length) {
      const keys = [...new Set(rbac.flatMap((b) => b.keys))];
      const confirmed = keys.filter((k) => rbac.some((b) => b.keys.includes(k) && !b.conditional.includes(k)));
      cells.highRbac = L(`${keys.map((k) => riskLabel(k) + (confirmed.includes(k) ? "" : " (조건부)")).join(", ")} (${rbac.map((b) => `${b.kind === "ClusterRoleBinding" ? "CRB" : "RB"} ${b.binding}`).join(", ")})`, `${keys.map((k) => riskLabel(k) + (confirmed.includes(k) ? "" : " (conditional)")).join(", ")} (${rbac.map((b) => `${b.kind === "ClusterRoleBinding" ? "CRB" : "RB"} ${b.binding}`).join(", ")})`);
      weights.highRbac = confirmed.some((k) => GRADE[k] === "crit") ? "crit" : "warn";
    }
    if (sec?.usesSecrets) cells.secret = L("Secret 참조 (볼륨·envFrom·secretKeyRef)", "Secret references (volume · envFrom · secretKeyRef)");
    if (!sel.ingress.length) cells.noIngress = L("정책 0", "0 policies");
    if (!sel.egress.length) cells.noEgress = L("정책 0", "0 policies");
    const ns = psaOf.get(w.namespace);
    if (ns && !["baseline", "restricted"].includes(ns.psaEffectiveEnforce)) cells.psa = L(`enforce: ${ns.psa.enforce ?? "(라벨 없음 → privileged)"}`, `enforce: ${ns.psa.enforce ?? "(no label → privileged)"}`);
    for (const f of factors()) if (cells[f.key] && !weights[f.key]) weights[f.key] = f.weight;
    const row: WorkloadRiskRow = {
      id: wid(w), namespace: w.namespace, name: w.name, kind: w.kind, pods: w.replicas,
      managed: isAksManaged(w.labels), owner: ownerOf(w), serviceAccount: sa,
      cells, weights, combos: [], score: 0, images: [...new Set((sec?.containers ?? []).map((c) => c.image).filter(Boolean))],
      bindings: rbac.map((b) => b.binding),
    };
    return { row, w, sel, exposure, rbac };
  });
}

/** Toxic combinations — each names the factors that form it. */
export function combosOf(cells: WorkloadRiskRow["cells"], weights: WorkloadRiskRow["weights"]): WorkloadRiskRow["combos"] {
  const out: WorkloadRiskRow["combos"] = [];
  if (cells.secret && cells.noEgress && cells.extEgress) out.push({ type: "exfil", keys: ["secret", "noEgress", "extEgress"], issueId: null });
  if (cells.highRbac && weights.highRbac === "crit" && cells.automount && (cells.root || cells.privEsc)) {
    out.push({ type: "takeover", keys: ["highRbac", "automount", cells.root ? "root" : "privEsc"], issueId: null });
  } else if (cells.highRbac && cells.automount) {
    out.push({ type: "standing", keys: ["highRbac", "automount"], issueId: null });
  }
  if (cells.exposure && cells.noIngress) out.push({ type: "vnet", keys: ["exposure", "noIngress"], issueId: null });
  return out;
}

// ── Issues (risk combinations with attack paths) ──

const flowsLabel = (n: number) => `${n} flows`;

function findingsFor(policy: KubernetesPolicyResponse, pred: (f: PolicyFinding) => boolean): string[] {
  return policy.findings.filter((f) => !f.system && f.severity !== "info" && pred(f)).map((f) => f.id);
}

function egressPolicyCode(c: RowCtx, net: NetworkInsight): string {
  const out = net.edges.filter((e) => e.from === c.row.id);
  const fqdn = out.filter((e) => e.cls === "cloud").map((e) => ({ host: net.nodes.find((n) => n.id === e.to)?.host, ports: e.ports }));
  const inCluster = out.filter((e) => e.cls === "eastwest");
  const appLabel = Object.entries(c.w.podLabels)[0];
  const lines = [
    "apiVersion: cilium.io/v2",
    "kind: CiliumNetworkPolicy",
    "metadata:",
    `  name: ${c.w.name}-egress`,
    `  namespace: ${c.w.namespace}`,
    "spec:",
    "  endpointSelector:",
    L(`    matchLabels: { ${appLabel ? `${appLabel[0]}: ${appLabel[1]}` : "<파드 라벨>"} }`, `    matchLabels: { ${appLabel ? `${appLabel[0]}: ${appLabel[1]}` : "<pod labels>"} }`),
    "  egress:",
    "  - toEndpoints: [{ matchLabels: { k8s:io.kubernetes.pod.namespace: kube-system, k8s-app: kube-dns } }]",
    '    toPorts: [{ ports: [{ port: "53", protocol: ANY }], rules: { dns: [{ matchPattern: "*" }] } }]',
    ...fqdn.flatMap((f) => [
      L(`  - toFQDNs: [{ matchName: ${f.host ?? "<호스트>"} }]`, `  - toFQDNs: [{ matchName: ${f.host ?? "<host>"} }]`),
      `    toPorts: [{ ports: [${f.ports.map((p) => `{ port: "${p.replace(/\D/g, "")}", protocol: TCP }`).join(", ")}] }]`,
    ]),
    ...inCluster.filter((e) => !e.to.startsWith("kube-system/coredns")).map((e) => `  - toEndpoints: [{ matchLabels: { k8s:io.kubernetes.pod.namespace: ${e.to.split("/")[0]} } }]   # → ${e.to.split("/")[1]} ${e.ports.join(",")}`),
    L("# 관측 구간에 없던 목적지는 차단됩니다 — 관측 모드(audit)로 먼저 운영하세요", "# Destinations not seen in the observed window are blocked — run in audit mode first"),
  ];
  return lines.join("\n");
}

function securityContextCode(c: RowCtx): string {
  return [
    "spec:",
    "  template:",
    "    spec:",
    ...(c.row.cells.automount ? [L("+     automountServiceAccountToken: false   # API 호출이 필요 없을 때만", "+     automountServiceAccountToken: false   # only when no API calls are needed")] : []),
    "      containers:",
    `      - name: ${c.w.security?.containers.find((x) => !x.init)?.name ?? "<container>"}`,
    "        securityContext:",
    "+         allowPrivilegeEscalation: false",
    "+         runAsNonRoot: true",
    "+         capabilities: { drop: [ALL] }",
  ].join("\n");
}

function psaCode(ns: string, k8sVersion: string): string {
  const v = k8sVersion.split(".").slice(0, 2).join(".");
  return [`kubectl label ns ${ns} \\`, "  pod-security.kubernetes.io/enforce=baseline \\", `  pod-security.kubernetes.io/enforce-version=v${v.replace(/^v/, "") || "latest"} \\`, "  pod-security.kubernetes.io/warn=restricted \\", "  pod-security.kubernetes.io/audit=restricted"].join("\n");
}

function rbacReduceCode(c: RowCtx, keys: RbacRiskKey[]): string {
  const lines = [`# ${c.rbac.map((b) => `${b.kind} ${b.binding} → ${b.role}`).join(", ")}`];
  for (const b of c.rbac) for (const r of b.rules) lines.push(`- ${r}`);
  lines.push(L(`# 제거 대상: ${keys.map((k) => riskLabel(k)).join(", ")} — 필요한 리소스·동사만 남기세요`, `# Remove: ${keys.map((k) => riskLabel(k)).join(", ")} — keep only the resources and verbs you need`));
  if (c.row.owner.startsWith("Helm")) lines.push(L("# Helm 차트라면 values의 rbac 항목에서 수정해야 업그레이드 후에도 유지됩니다", "# For a Helm chart, change the rbac values so the fix survives upgrades"));
  return lines.join("\n");
}

function saCmd(c: RowCtx): string {
  return `kubectl auth can-i --list --as=system:serviceaccount:${c.w.namespace}:${c.row.serviceAccount}`;
}

function workloadFacts(c: RowCtx): FactRow[] {
  const r = c.row;
  return [
    { k: L("위치", "Location"), v: `${r.namespace} · ${r.kind} ×${r.pods} · ${r.owner}`, ev: "cfg", src: "K8s API" },
    { k: L("서비스 계정", "Service account"), v: `${r.namespace}/${r.serviceAccount}`, ev: "cfg", src: "pod spec.serviceAccountName", mono: true },
    ...(c.exposure.services.length ? [{ k: "Service", v: c.exposure.services.join(", "), ev: "cfg" as EvidenceKind, src: L("Service selector 일치", "Service selector match") }] : []),
    { k: L("Ingress 정책", "Ingress policies"), v: c.sel.ingress.join(", ") || "0", ev: "cfg", src: L("NetworkPolicy·CiliumNetworkPolicy 선택 결과", "Selected by NetworkPolicy · CiliumNetworkPolicy") },
    { k: L("Egress 정책", "Egress policies"), v: c.sel.egress.join(", ") || "0", ev: "cfg", src: L("NetworkPolicy·CiliumNetworkPolicy 선택 결과", "Selected by NetworkPolicy · CiliumNetworkPolicy") },
  ];
}

export function buildIssues(input: InsightsInput, ctxs: RowCtx[], net: NetworkInsight): RiskIssue[] {
  const { policy, containment } = input;
  const issues: RiskIssue[] = [];
  const cov = net.coverage;
  const hubbleNote = cov ? L(`노드 ${cov.nodesObserved}/${cov.nodesTotal} · 공통 ${cov.commonWindowMinutes}분`, `Nodes ${cov.nodesObserved}/${cov.nodesTotal} · common ${cov.commonWindowMinutes} min`) : L("Hubble 미연결", "Hubble not connected");
  const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
  const c0 = containment.cluster;
  const podsTotal = input.inventory.pods.filter((p) => p.phase !== "Succeeded" && p.phase !== "Failed").length;
  const nodeCount = input.inventory.nodes?.length ?? c0.nodes;

  // ① AKS local accounts → cluster-admin
  const adminBinding = input.inventory.bindings.find((b) => b.roleRef.name === "cluster-admin" && b.subjects.some((s) => s.kind === "User" && /clusterAdmin|clusterUser/i.test(s.name)));
  if (c0.localAccounts === true) {
    const id = "local-accounts";
    const findingIds = findingsFor(policy, (f) => f.ruleId === "RBAC-001" && (!adminBinding || f.resource?.name === adminBinding.name));
    issues.push({
      id, sev: "crit", kind: "local",
      title: c0.entraIntegrated === false
        ? L("AKS 로컬 계정이 켜져 있고 Entra ID 통합이 없어, 로컬 kubeconfig 하나로 클러스터 전체를 장악할 수 있음", "AKS local accounts are on and Entra ID is not integrated: one local kubeconfig can take over the whole cluster")
        : L("AKS 로컬 계정이 켜져 있어, Entra ID를 거치지 않는 관리자 kubeconfig로 클러스터 전체를 장악할 수 있음", "AKS local accounts are on: an admin kubeconfig that bypasses Entra ID can take over the whole cluster"),
      owner: L("Azure 설정", "Azure settings"), ownerGroup: "azure", findingIds, extraEvidence: [["cfg", L("Azure 설정 확인", "Azure settings check")]],
      nodes: [
        { id: "azrole", col: 0, row: 0, type: "azure", label: L("Azure 역할 보유자", "Azure role holders"), sub: L("역할 할당 미수집", "Role assignments not collected"), unk: true, facts: [{ k: L("역할 할당", "Role assignments"), v: L("미수집", "Not collected"), ev: "unk", src: L("Azure RBAC 역할 할당 조회 시 확정", "Confirmed by listing Azure RBAC role assignments") }], refs: [] },
        { id: "kc", col: 1, row: 0, type: "credential", label: L("로컬 kubeconfig", "Local kubeconfig"), sub: L("인증서 · 만료 전까지 유효", "Certificate · valid until it expires"), facts: [{ k: L("발급", "Issued"), v: "az aks get-credentials --admin", ev: "cfg", mono: true }, { k: L("인증서 만료", "Certificate expiry"), v: L("미수집", "Not collected"), ev: "unk" }], refs: [] },
        { id: "users", col: 2, row: 0, type: "identity", label: "clusterAdmin · clusterUser", sub: "disableLocalAccounts=false", facts: [
          { k: "disableLocalAccounts", v: "false", ev: "cfg", src: "ARM managedClusters.properties", mono: true },
          { k: L("Entra ID 통합", "Entra ID integration"), v: c0.entraIntegrated === null ? L("미확인", "Unknown") : String(c0.entraIntegrated), ev: c0.entraIntegrated === null ? "unk" : "cfg", src: "aadProfile.managed" },
          { k: "Azure RBAC", v: c0.azureRbac === null ? L("미확인", "Unknown") : String(c0.azureRbac), ev: c0.azureRbac === null ? "unk" : "cfg", src: "aadProfile.enableAzureRBAC" },
        ], refs: [] },
        { id: "crb", col: 3, row: 0, type: "permission", label: "cluster-admin", sub: adminBinding?.name ?? L("바인딩 미확인", "Binding unknown"), badges: adminBinding ? [{ n: 1, what: L("바인딩", "Binding") }] : [], facts: adminBinding ? [
          { k: L("바인딩", "Binding"), v: `${adminBinding.kind} ${adminBinding.name}`, ev: "perm", mono: true },
          { k: L("주체", "Subject"), v: adminBinding.subjects.map((s) => `${s.kind}:${s.name}`).join(", "), ev: "perm", mono: true },
        ] : [{ k: L("바인딩", "Binding"), v: L("미확인", "Unknown"), ev: "unk" }], refs: [] },
        { id: "impact", col: 4, row: 0, type: "impact", label: L("클러스터 전체", "Whole cluster"), sub: L("모든 네임스페이스·Secret·노드", "Every namespace · Secret · node"), facts: [{ k: L("범위", "Scope"), v: "cluster-admin = * / * / *", ev: "perm" }], refs: [] },
      ],
      edges: [
        { from: "azrole", to: "kc", ev: "unk", label: L("자격증명 다운로드 ?", "Download credentials ?"), why: L("'Azure Kubernetes Service Cluster Admin Role' 보유자를 조회하지 않았습니다", "Holders of 'Azure Kubernetes Service Cluster Admin Role' were not listed") },
        { from: "kc", to: "users", ev: "cfg", label: c0.entraIntegrated === false ? L("인증서 인증 (Entra 미통합)", "Certificate auth (no Entra integration)") : L("인증서 인증 (Entra 우회)", "Certificate auth (bypasses Entra)") },
        { from: "users", to: "crb", ev: "perm", label: L("바인딩 주체", "Bound subject"), cut: `${id}:disable` },
        { from: "crb", to: "impact", ev: "perm", label: "* / * / *" },
      ],
      actions: [{
        id: `${id}:disable`, title: L("Entra ID 통합 + Azure RBAC 후 로컬 계정 비활성화", "Disable local accounts after Entra ID + Azure RBAC integration"),
        desc: L("선행: --enable-aad · --enable-azure-rbac. admin kubeconfig를 쓰는 파이프라인을 먼저 확인하세요(Activity Log 미수집).", "Prerequisite: --enable-aad · --enable-azure-rbac. Check pipelines that use the admin kubeconfig first (Activity Log not collected)."),
        risk: "crit", riskLabel: L("중단 위험", "May disrupt"), closes: findingIds, cuts: ["users>crb"], effect: "closed",
        code: L(`# 1) Entra ID 통합 + Azure RBAC\naz aks update -g ${containment.resourceGroup} -n ${c0.name} --enable-aad --enable-azure-rbac\n# 2) 사용처 정리 후 로컬 계정 비활성화\naz aks update -g ${containment.resourceGroup} -n ${c0.name} --disable-local-accounts`, `# 1) Entra ID integration + Azure RBAC\naz aks update -g ${containment.resourceGroup} -n ${c0.name} --enable-aad --enable-azure-rbac\n# 2) After moving the users off, disable local accounts\naz aks update -g ${containment.resourceGroup} -n ${c0.name} --disable-local-accounts`),
      }],
    });
  }

  const nsFindings = (ns: string, rules: string[]) => findingsFor(policy, (f) => f.namespace === ns && rules.includes(f.ruleId));
  const rbacFindings = (bindings: string[]) => findingsFor(policy, (f) => f.category === "rbac" && !!f.resource && bindings.includes(f.resource.name));
  const user = ctxs.filter((c) => !c.row.managed);
  const apiFlows = (id: string) => net.edges.filter((e) => e.from === id && e.cls === "control" && e.to === "apiserver").reduce((s, e) => s + e.count, 0);

  // ② Data-exfiltration path per workload
  for (const c of user.filter((x) => x.row.combos.some((k) => k.type === "exfil"))) {
    const r = c.row;
    const id = `exfil:${r.id}`;
    const out = net.edges.filter((e) => e.from === r.id && (e.cls === "cloud" || e.cls === "internet")).slice(0, 3);
    const pubPaas = out.map((e) => nodeById.get(e.to)).filter((n) => n?.kind === "paas" && n.publicAccess === "Enabled");
    const findingIds = [...nsFindings(r.namespace, ["NET-003", "PSA-001", "PSA-002"])];
    const fqdnId = `${id}:fqdn`, peId = `${id}:pe`, scId = `${id}:sc`, psaId = `${id}:psa`;
    const nodes: AttackNode[] = [
      c.exposure.text.length
        ? { id: "entry", col: 0, row: 1, type: "network", label: c.exposure.text[0]!, sub: c.exposure.text.slice(1).join(" · ") || L("노출 경로", "Exposure path"), facts: workloadFacts(c).slice(2), refs: [] }
        : { id: "entry", col: 0, row: 1, type: "network", label: L("클러스터 내부만", "Inside the cluster only"), sub: c.exposure.services[0] ?? L("Service 없음", "No Service"), unk: true, facts: [{ k: L("외부 노출", "External exposure"), v: L("없음 (LoadBalancer·NodePort·Ingress·HTTPRoute 0)", "None (0 LoadBalancer · NodePort · Ingress · HTTPRoute)"), ev: "cfg" }, ...workloadFacts(c).slice(2, 4)], refs: [] },
      { id: "app", col: 1, row: 1, type: "workload", label: `${r.name} ×${r.pods}`, sub: [r.cells.root && L("root 가능", "May run as root"), r.cells.privEsc && L("권한상승 허용", "Privilege escalation allowed"), r.cells.psa && L("PSA 미적용", "No PSA")].filter(Boolean).join(" · ") || r.kind, badges: [{ n: r.pods, what: L("파드", "Pod") }], facts: workloadFacts(c), refs: [r.id] },
      { id: "secret", col: 2, row: 0, type: "secret", label: L("Secret 참조", "Secret references"), sub: L("이름·키 미수집", "Names and keys not collected"), facts: [{ k: L("참조", "References"), v: L("있음", "Yes"), ev: "cfg", src: "volumes / envFrom / secretKeyRef" }, { k: L("Secret 이름·키", "Secret names · keys"), v: L("미수집", "Not collected"), ev: "unk", src: L("내용은 수집하지 않습니다", "Contents are never collected") }], refs: [] },
      ...(r.cells.automount ? [{ id: "token", col: 2 as const, row: 2, type: "identity" as const, label: L("SA 토큰 (자동 마운트)", "SA token (auto-mounted)"), sub: L(`관측 구간 apiserver 호출 ${apiFlows(r.id)}건`, `${apiFlows(r.id)} apiserver calls in the observed window`), facts: [
        { k: L("서비스 계정", "Service account"), v: `${r.namespace}/${r.serviceAccount}`, ev: "cfg" as EvidenceKind, mono: true },
        { k: L("apiserver 호출", "apiserver calls"), v: L(`${apiFlows(r.id)}건`, `${apiFlows(r.id)}`), ev: "obs" as EvidenceKind, src: L(`관측 구간(${hubbleNote}) 기준 — 0건은 미사용의 증거가 아님`, `Within the observed window (${hubbleNote}) — 0 is not proof of non-use`) },
      ], refs: [r.id], cmd: saCmd(c) }] : []),
      ...out.map((e, i): AttackNode => {
        const n = nodeById.get(e.to)!;
        return n.kind === "paas"
          ? { id: `dst${i}`, col: 3, row: i, type: "azure", label: n.label, sub: L(`${n.azureType} :${e.ports.join(",")} · ${flowsLabel(e.count)} · 공용 액세스 ${n.publicAccess === "Enabled" ? "켜짐" : n.publicAccess === "Disabled" ? "꺼짐" : "?"}`, `${n.azureType} :${e.ports.join(",")} · ${flowsLabel(e.count)} · public access ${n.publicAccess === "Enabled" ? "on" : n.publicAccess === "Disabled" ? "off" : "?"}`), facts: [
            { k: L("호스트", "Host"), v: n.host ?? "?", ev: "cfg", src: L("ARM 리소스 속성", "ARM resource property"), mono: true },
            { k: L("공용 네트워크 액세스", "Public network access"), v: n.publicAccess ?? L("미확인", "Unknown"), ev: n.publicAccess ? "cfg" : "unk", src: "ARM publicNetworkAccess" },
            { k: L("매칭", "Match"), v: L(`Hubble 목적지 IP ${n.ips?.join(", ")} = 호스트 DNS 조회 IP`, `Hubble destination IP ${n.ips?.join(", ")} = host DNS lookup IP`), ev: "obs" },
            ...(n.sharedIpWith ? [{ k: L("식별 확실성", "Identification"), v: L(`같은 프런트엔드 IP를 ${n.sharedIpWith.join(", ")}와 공유 — 리소스 특정 불확실`, `Shares the frontend IP with ${n.sharedIpWith.join(", ")} — the resource is uncertain`), ev: "unk" as EvidenceKind }] : []),
            { k: L("Private Endpoint·방화벽", "Private Endpoint · firewall"), v: L("미수집", "Not collected"), ev: "unk" },
          ], refs: [n.id] }
          : { id: `dst${i}`, col: 3, row: i, type: "network", label: L("미식별 외부", "Unidentified external"), sub: `:${e.ports.join(",")} · ${flowsLabel(e.count)}`, unk: true, facts: net.unmatchedExternal.filter((u) => u.from.includes(r.id)).map((u) => ({ k: u.ip, v: `:${u.ports.join(",")} · ${u.count}`, ev: "obs" as EvidenceKind, mono: true })), refs: [n.id] };
      }),
      { id: "any", col: 4, row: 1, type: "impact", label: L("임의의 클러스터 외부", "Anywhere outside the cluster"), sub: L(`egress 정책 0 · outboundType=${c0.outboundType ?? "?"}`, `0 egress policies · outboundType=${c0.outboundType ?? "?"}`), unk: true, facts: [
        { k: L("Egress 정책", "Egress policies"), v: "0", ev: "cfg", src: L("NetworkPolicy·CiliumNetworkPolicy 선택 결과", "Selected by NetworkPolicy · CiliumNetworkPolicy") },
        { k: "outboundType", v: c0.outboundType ?? L("미확인", "Unknown"), ev: c0.outboundType ? "cfg" : "unk", src: "ARM networkProfile", mono: true },
        { k: L("실제 도달 범위", "Actual reach"), v: L("미확인", "Unknown"), ev: "unk", src: L("클러스터 수준 제한 없음 — NSG·방화벽은 미수집", "No cluster-level limit — NSG and firewall not collected") },
      ], refs: [] },
    ];
    const edges: AttackEdge[] = [
      { from: "entry", to: "app", ev: "cfg", label: c.exposure.text.length ? L("노출", "Exposure") : (c.exposure.services[0]?.split(" ")[0] ?? L("Service 없음", "No Service")) },
      { from: "app", to: "secret", ev: "cfg", label: L("볼륨/환경변수", "Volume / env var") },
      ...(r.cells.automount ? [{ from: "app", to: "token", ev: "cfg" as EvidenceKind, label: "automount=true" }] : []),
      ...out.map((e, i): AttackEdge => ({ from: "app", to: `dst${i}`, ev: "obs", label: L(`${flowsLabel(e.count)}${nodeById.get(e.to)?.kind === "paas" ? " · 공인 IP" : ""}`, `${flowsLabel(e.count)}${nodeById.get(e.to)?.kind === "paas" ? " · public IP" : ""}`), ...(i === 0 && pubPaas.length ? { cut: peId } : {}) })),
      { from: "app", to: "any", ev: "cfg", label: L("송신 제한 없음 ?", "No egress limit ?"), cut: fqdnId },
    ];
    const actions: RemediationAction[] = [
      { id: fqdnId, title: L("ACNS FQDN 송신 정책 (관측된 목적지만 허용)", "ACNS FQDN egress policy (allow observed destinations only)"), desc: L(`관측 목적지 ${net.edges.filter((e) => e.from === r.id).length}곳 기준 초안. 관측 범위가 ${hubbleNote}라 드문 흐름은 빠져 있을 수 있음 → 관측 모드 운영 후 적용.`, `Draft based on ${net.edges.filter((e) => e.from === r.id).length} observed destinations. The observed window is ${hubbleNote}, so rare flows may be missing → run in audit mode before enforcing.`), risk: "warn", riskLabel: L("주의", "Caution"), closes: nsFindings(r.namespace, ["NET-003"]), cuts: ["app>any"], effect: "closed", code: egressPolicyCode(c, net) },
      ...(pubPaas.length ? [{ id: peId, title: L(`Private Endpoint로 전환 후 ${pubPaas.map((n) => n!.label).join("·")} 공용 액세스 끄기`, `Move to Private Endpoints, then turn off public access on ${pubPaas.map((n) => n!.label).join("·")}`), desc: L("클러스터 → Azure PaaS 트래픽이 아웃바운드 SNAT으로 공인 IP를 거쳐 나갑니다. 다른 클라이언트가 공용 경로를 쓰는지 먼저 확인(방화벽 규칙 미수집).", "Cluster → Azure PaaS traffic leaves through outbound SNAT over a public IP. Check whether other clients use the public path first (firewall rules not collected)."), risk: "warn" as const, riskLabel: L("주의", "Caution"), closes: [], cuts: ["app>dst0"], effect: "reduced" as const,
        code: pubPaas.map((n) => L(`# ${n!.label} (${n!.azureType})\naz network private-endpoint create -g ${containment.resourceGroup} -n pe-${n!.label} --vnet-name <aks-vnet> --subnet <pe-subnet> \\\n  --private-connection-resource-id <${n!.label} 리소스 ID> --group-id <하위 리소스> --connection-name ${n!.label}`, `# ${n!.label} (${n!.azureType})\naz network private-endpoint create -g ${containment.resourceGroup} -n pe-${n!.label} --vnet-name <aks-vnet> --subnet <pe-subnet> \\\n  --private-connection-resource-id <${n!.label} resource ID> --group-id <sub-resource> --connection-name ${n!.label}`)).join("\n") + L("\n# 파드에서 FQDN이 사설 IP로 풀리는지 확인한 뒤 공용 액세스를 끄세요", "\n# Check that the FQDN resolves to a private IP from a pod, then turn off public access") }] : []),
      ...(r.cells.root || r.cells.privEsc ? [{ id: scId, title: L("securityContext 강화 (allowPrivilegeEscalation:false · runAsNonRoot)", "Harden securityContext (allowPrivilegeEscalation:false · runAsNonRoot)"), desc: L("이미지의 USER·setuid 사용 여부는 수집하지 않았습니다 → 스테이징에서 검증 후 적용.", "Whether the image uses USER or setuid was not collected → verify in staging first."), risk: "warn" as const, riskLabel: L("주의", "Caution"), closes: [], cuts: [], effect: "reduced" as const, code: securityContextCode(c) }] : []),
      ...(r.cells.psa ? [{ id: psaId, title: L(`${r.namespace}에 PSA 라벨 (enforce=baseline · warn/audit=restricted)`, `PSA labels on ${r.namespace} (enforce=baseline · warn/audit=restricted)`), desc: L("enforce는 새로 생성되는 파드에만 적용됩니다. 먼저 warn/audit로 위반을 확인하세요.", "enforce applies only to newly created pods. Check violations with warn/audit first."), risk: "ok" as const, riskLabel: L("안전", "Safe"), closes: nsFindings(r.namespace, ["PSA-001", "PSA-002"]), cuts: [], effect: "closed" as const, code: psaCode(r.namespace, c0.k8sVersion) }] : []),
    ];
    issues.push({
      id, sev: "crit", kind: "exfil",
      title: L(`${r.name}(파드 ${r.pods})${r.cells.root || r.cells.privEsc ? `이 ${[r.cells.root && "root 실행 가능", r.cells.privEsc && "권한 상승 허용"].filter(Boolean).join("·")} 상태로` : "이"} Secret${r.cells.automount ? "과 SA 토큰" : ""}을 마운트한 채, 송신 제한 없이 ${out.map((e) => nodeById.get(e.to)!).map((n) => (n.kind === "paas" ? `${n.azureType}(${n.label})` : "미식별 외부")).join("·")}와 통신 중`, `${r.name} (${r.pods} pods)${r.cells.root || r.cells.privEsc ? `, ${[r.cells.root && "may run as root", r.cells.privEsc && "privilege escalation allowed"].filter(Boolean).join(" and ")},` : ""} mounts Secrets${r.cells.automount ? " and an SA token" : ""} and talks to ${out.map((e) => nodeById.get(e.to)!).map((n) => (n.kind === "paas" ? `${n.azureType}(${n.label})` : "unidentified external")).join("·")} with no egress limit`),
      owner: `${r.owner} · ${r.namespace}`, ownerGroup: "mine", findingIds,
      extraEvidence: [...(out.some((e) => nodeById.get(e.to)?.kind === "paas") ? [["obs", L(`Azure 리소스 매칭 ${out.filter((e) => nodeById.get(e.to)?.kind === "paas").length}`, `Azure resources matched ${out.filter((e) => nodeById.get(e.to)?.kind === "paas").length}`)] as [EvidenceKind, string]] : []), ...(!c.exposure.text.length ? [["unk", L("진입: 외부 노출 없음", "Entry: no external exposure")] as [EvidenceKind, string]] : [])],
      nodes, edges, actions,
    });
    r.combos.find((k) => k.type === "exfil")!.issueId = id;
  }

  // ③ Cluster-takeover path per workload (crit RBAC + token + weak runtime)
  for (const c of user.filter((x) => x.row.combos.some((k) => k.type === "takeover"))) {
    const r = c.row;
    const id = `takeover:${r.id}`;
    const crit = [...new Set(c.rbac.flatMap((b) => b.keys.filter((k) => GRADE[k] === "crit" && !b.conditional.includes(k))))];
    const api = apiFlows(r.id);
    const rbacId = `${id}:rbac`, egId = `${id}:egress`;
    const impact = crit.includes("clusterAdmin") ? [L("클러스터 전체", "Whole cluster"), "* / * / *"]
      : crit.includes("nodesProxy") ? [L(`노드 ${nodeCount}대의 파드 ${podsTotal}개`, `${podsTotal} pods on ${nodeCount} nodes`), L("kubelet exec → 노드의 모든 파드", "kubelet exec → every pod on the node")]
        : crit.includes("webhook") ? [L("모든 파드 생성 요청", "Every pod create request"), L("admission 변조 → 임의 컨테이너 주입", "Admission tampering → inject any container")]
          : crit.includes("escalate") ? [L("임의 권한 획득", "Gain any permission"), "bind/escalate → cluster-admin"]
            : [L("다른 사용자 권한", "Other users' permissions"), "impersonate"];
    const findingIds = [...rbacFindings(r.bindings), ...nsFindings(r.namespace, ["NET-003"])];
    issues.push({
      id, sev: "crit", kind: "takeover",
      title: L(`${r.name}(${r.kind} ${r.pods})의 SA 토큰이 ${crit.map((k) => riskLabel(k)).join("·")} 권한을 가져, 침해 시 ${impact[0]}에 영향을 줄 수 있음 [추론]`, `The SA token of ${r.name} (${r.kind} ${r.pods}) has ${crit.map((k) => riskLabel(k)).join("·")}; if compromised it could affect ${impact[0]} [inferred]`),
      owner: `${r.owner} · ${r.namespace}`, ownerGroup: r.owner.startsWith("kubectl") && !r.namespace.startsWith("kube-") ? "mine" : "addon", findingIds,
      extraEvidence: [["unk", L("진입 미확인", "Entry unknown")]],
      nodes: [
        { id: "entry", col: 0, row: 1, type: "network", label: L("진입 미확인", "Entry unknown"), sub: c.exposure.text[0] ?? L("이미지 취약성 미연동", "Image vulnerabilities not connected"), unk: !c.exposure.text.length, facts: [{ k: L("진입 경로", "Entry path"), v: c.exposure.text.join(" · ") || L("미확인", "Unknown"), ev: c.exposure.text.length ? "cfg" : "unk", src: L("이미지 취약성(CVE)·런타임 정보 미연동", "Image vulnerabilities (CVE) · runtime data not connected") }], refs: [] },
        { id: "app", col: 1, row: 1, type: "workload", label: `${r.name} ×${r.pods}`, sub: [r.cells.root && L("root 가능", "May run as root"), r.cells.privEsc && L("권한상승 허용", "Privilege escalation allowed"), r.cells.noIngress && L("격리 없음", "No isolation")].filter(Boolean).join(" · "), badges: [{ n: r.pods, what: L("파드", "Pod") }], facts: workloadFacts(c), refs: [r.id] },
        { id: "sa", col: 2, row: 1, type: "identity", label: L(`SA ${r.serviceAccount} 토큰`, `SA ${r.serviceAccount} token`), sub: "automount=true", facts: [{ k: L("서비스 계정", "Service account"), v: `${r.namespace}/${r.serviceAccount}`, ev: "cfg", mono: true }, { k: L("토큰 자동 마운트", "Token auto-mounted"), v: "true", ev: "cfg", src: "pod spec" }], refs: [r.id], cmd: saCmd(c) },
        ...(api ? [{ id: "api", col: 3 as const, row: 0, type: "permission" as const, label: "kube-apiserver :443", sub: L(`${flowsLabel(api)} · 정상 동작 포함`, `${flowsLabel(api)} · includes normal operation`), facts: [{ k: "flows", v: String(api), ev: "obs" as EvidenceKind, src: hubbleNote }, { k: L("호출한 API", "APIs called"), v: L("미수집 (L7 미관측)", "Not collected (no L7 visibility)"), ev: "unk" as EvidenceKind }], refs: ["apiserver"] }] : []),
        { id: "perm", col: 3, row: 2, type: "permission", label: crit.map((k) => riskLabel(k)).join(" · "), sub: c.rbac.map((b) => b.binding).join(", "), badges: [{ n: [...new Set(c.rbac.flatMap((b) => b.keys))].length, what: L("위험 권한 종류", "risky permission kinds") }], facts: c.rbac.flatMap((b) => [
          { k: L("바인딩", "Binding"), v: `${b.kind} ${b.binding} → ${b.role}`, ev: "perm" as EvidenceKind, mono: true },
          { k: L("규칙", "Rules"), v: b.rules.join(" | "), ev: "perm" as EvidenceKind, mono: true, src: "resources:verbs" },
          ...(b.conditional.length ? [{ k: L("조건부", "Conditional"), v: b.conditional.map((k) => riskLabel(k)).join(", "), ev: "unk" as EvidenceKind, src: L("약한 동사로만 성립 — 미검증", "Holds only through weak verbs — not verified") }] : []),
        ]), refs: [r.id], cmd: saCmd(c) },
        { id: "impact", col: 4, row: 1, type: "impact", label: impact[0]!, sub: impact[1]!, unk: true, facts: [{ k: L("파드", "Pods"), v: String(podsTotal), ev: "cfg", src: "K8s API" }, { k: L("실제 악용 가능", "Actually exploitable"), v: L("미검증", "Not verified"), ev: "unk", src: L("권한 정의에서 추론 — 이 클러스터에서 재현하지 않음", "Inferred from the permission definitions — not reproduced on this cluster") }], refs: [] },
      ],
      edges: [
        { from: "entry", to: "app", ev: c.exposure.text.length ? "cfg" : "unk", label: c.exposure.text.length ? L("노출", "Exposure") : "?", why: L("진입 조건(취약 이미지·노출) 데이터가 없습니다", "No data on entry conditions (vulnerable image · exposure)") },
        { from: "app", to: "sa", ev: "cfg", label: L("토큰 마운트", "Token mount") },
        ...(api ? [{ from: "sa", to: "api", ev: "obs" as EvidenceKind, label: flowsLabel(api) }] : []),
        { from: "sa", to: "perm", ev: "perm", label: c.rbac.map((b) => b.binding).join(", "), cut: rbacId },
        { from: "perm", to: "impact", ev: "unk", label: L(`${crit.map((k) => riskLabel(k)).join("·")} 악용 ?`, `${crit.map((k) => riskLabel(k)).join("·")} abuse ?`), why: L("권한 정의에서 추론한 영향 — 재현 검증하지 않았습니다", "Impact inferred from the permission definitions — not verified by reproduction") },
      ],
      actions: [
        { id: rbacId, title: L(`${r.name} 역할에서 ${crit.map((k) => riskLabel(k)).join("·")} 제거`, `Remove ${crit.map((k) => riskLabel(k)).join("·")} from the ${r.name} role`), desc: crit.includes("nodesProxy") ? L("nodes/proxy 대신 nodes/metrics·nodes/stats로 바꾸세요. kubelet 세분화 인가 지원 전에는 cAdvisor 수집이 끊길 수 있습니다.", "Use nodes/metrics · nodes/stats instead of nodes/proxy. Until kubelet fine-grained authorization is supported, cAdvisor collection may stop.") : L("필요한 리소스·동사만 남기세요. 벤더 차트면 예외 등록 + 보완 통제를 고려하세요.", "Keep only the resources and verbs you need. For a vendor chart, consider an exception plus compensating controls."), risk: "warn", riskLabel: L("주의", "Caution"), closes: rbacFindings(r.bindings), cuts: ["sa>perm"], effect: "closed", code: rbacReduceCode(c, crit) },
        ...(r.cells.noEgress ? [{ id: egId, title: L(`${r.namespace} 송신 정책 (관측된 목적지만)`, `${r.namespace} egress policy (observed destinations only)`), desc: L(`관측 목적지 ${net.edges.filter((e) => e.from === r.id).length}곳 기준. ${hubbleNote}.`, `Based on ${net.edges.filter((e) => e.from === r.id).length} observed destinations. ${hubbleNote}.`), risk: "warn" as const, riskLabel: L("주의", "Caution"), closes: nsFindings(r.namespace, ["NET-003"]), cuts: [], effect: "reduced" as const, code: egressPolicyCode(c, net) }] : []),
      ],
    });
    r.combos.find((k) => k.type === "takeover")!.issueId = id;
  }

  // ④ Exposed without ingress isolation, per namespace
  const vnetNs = [...new Set(user.filter((x) => x.row.combos.some((k) => k.type === "vnet")).map((x) => x.row.namespace))];
  for (const ns of vnetNs) {
    const group = user.filter((x) => x.row.namespace === ns && x.row.combos.some((k) => k.type === "vnet"));
    const id = `vnet:${ns}`;
    const anyPublic = group.some((g) => g.exposure.public);
    const probes = net.edges.filter((e) => e.from === "probe:lb" && group.some((g) => g.row.id === e.to)).reduce((s, e) => s + e.count, 0);
    const remote = net.edges.filter((e) => e.from === "ext:remote-node" && group.some((g) => g.row.id === e.to));
    const findingIds = nsFindings(ns, ["NET-001"]);
    const cnpId = `${id}:ingress`;
    issues.push({
      id, sev: anyPublic ? "crit" : "warn", kind: "vnet",
      title: L(`${ns}의 ${group.length}개 워크로드(${group.map((g) => g.row.name).join("·")})가 ${anyPublic ? "공인" : "VNet"}에 노출된 채 수신 정책 없이 열려 있어, ${anyPublic ? "인터넷" : "VNet 안"}에서 인증 없이 API에 접근할 수 있음`, `${group.length} workloads in ${ns} (${group.map((g) => g.row.name).join("·")}) are exposed to ${anyPublic ? "the internet" : "the VNet"} with no ingress policy, so their APIs can be reached without authentication from ${anyPublic ? "the internet" : "inside the VNet"}`),
      owner: [...new Set(group.map((g) => g.row.owner))].join(" · "), ownerGroup: group.every((g) => g.row.owner.startsWith("Helm")) ? "addon" : "mine", findingIds,
      extraEvidence: [["unk", net.available ? L("VNet 클라이언트 판별 불가(SNAT)", "VNet clients cannot be told apart (SNAT)") : L("도달 범위 미확인", "Reach unknown")]],
      confNote: net.available && remote.length ? L("remote-node 경유 flow는 SNAT로 VNet 클라이언트와 구분되지 않음", "Flows via remote-node are SNAT-ed and cannot be told apart from VNet clients") : undefined,
      nodes: [
        { id: "vnet", col: 0, row: 0, type: "azure", label: anyPublic ? L("인터넷 / VNet", "Internet / VNet") : L("VNet / 피어링", "VNet / peering"), sub: net.available ? L(`프로브 ${flowsLabel(probes)} 식별 · 클라이언트 판별 불가`, `${flowsLabel(probes)} probes identified · clients cannot be told apart`) : L("NSG·피어링 미수집", "NSG · peering not collected"), unk: true, facts: [
          { k: L("클라이언트", "Clients"), v: L("판별 불가", "Cannot be told apart"), ev: "unk", src: remote.length ? L(`remote-node 경유 flow(${remote.map((e) => `${nodeById.get(e.to)?.label} ×${e.count}`).join(", ")})는 SNAT로 출처가 가려짐`, `Flows via remote-node (${remote.map((e) => `${nodeById.get(e.to)?.label} ×${e.count}`).join(", ")}) hide their source behind SNAT`) : L("수신 flow 없음", "No inbound flows") },
          ...(net.available ? [{ k: L("LB 헬스 프로브", "LB health probe"), v: flowsLabel(probes), ev: "obs" as EvidenceKind, src: WIRESERVER }] : []),
          { k: L("NSG·피어링·loadBalancerSourceRanges", "NSG · peering · loadBalancerSourceRanges"), v: L("미수집", "Not collected"), ev: "unk" },
        ], refs: [] },
        { id: "lb", col: 1, row: 0, type: "network", label: L(`노출 ${group.reduce((s, g) => s + g.exposure.text.length, 0)}개`, `${group.reduce((s, g) => s + g.exposure.text.length, 0)} exposures`), sub: group.flatMap((g) => g.exposure.text).join(" · "), facts: group.map((g) => ({ k: g.row.name, v: g.exposure.text.join(" · "), ev: "cfg" as EvidenceKind, src: g.exposure.services.join(", ") })), refs: [] },
        { id: "pods", col: 2, row: 0, type: "workload", label: group.map((g) => g.row.name).join(" · "), sub: L(`수신 정책 0/${group.length}`, `Ingress policies 0/${group.length}`), facts: group.map((g) => ({ k: g.row.name, v: L(`Ingress 정책 ${g.sel.ingress.length}`, `Ingress policies ${g.sel.ingress.length}`), ev: "cfg" as EvidenceKind, src: L("NetworkPolicy·CiliumNetworkPolicy 선택 결과", "Selected by NetworkPolicy · CiliumNetworkPolicy") })), refs: group.map((g) => g.row.id) },
        { id: "data", col: 4, row: 0, type: "impact", label: L("서비스 API 무단 사용 ?", "Unauthorized use of the service API ?"), sub: L("인증 설정 미수집", "Authentication settings not collected"), unk: true, facts: [{ k: L("API 인증", "API authentication"), v: L("미확인", "Unknown"), ev: "unk", src: L("애플리케이션 인증 설정은 수집하지 않음", "Application authentication settings are not collected") }], refs: [] },
      ],
      edges: [
        { from: "vnet", to: "lb", ev: "unk", label: L("도달 가능 ?", "Reachable ?"), why: L("NSG·피어링·loadBalancerSourceRanges 미수집, remote-node flow는 SNAT로 출처 구분 불가", "NSG · peering · loadBalancerSourceRanges not collected; remote-node flows hide their source behind SNAT") },
        { from: "lb", to: "pods", ev: "cfg", label: L("수신 정책 0", "0 ingress policies"), cut: cnpId },
        { from: "pods", to: "data", ev: "unk", label: L("인증 ?", "Authentication ?"), why: L("애플리케이션 인증 설정을 수집하지 않았습니다", "Application authentication settings were not collected") },
      ],
      actions: [{
        id: cnpId, title: L(`${ns} 수신 정책 + loadBalancerSourceRanges`, `${ns} ingress policy + loadBalancerSourceRanges`), desc: L(`클러스터 내부 소비자와 Azure LB 프로브(${WIRESERVER})는 허용 유지. LB를 쓰는 VNet 소비자를 먼저 확인하세요.`, `Keep in-cluster consumers and the Azure LB probe (${WIRESERVER}) allowed. Check VNet consumers that use the LB first.`),
        risk: "warn", riskLabel: L("주의", "Caution"), closes: findingIds, cuts: ["lb>pods"], effect: "closed",
        code: [L(`# 1) ${ns} 기본 수신 차단 + 필요한 출처만 허용 (CiliumNetworkPolicy ingress)`, `# 1) ${ns}: deny ingress by default, allow only the needed sources (CiliumNetworkPolicy ingress)`), "# 2) LoadBalancer Service", "spec:", "  type: LoadBalancer", L("+ loadBalancerSourceRanges: [<허용할 VNet 서브넷 CIDR>]", "+ loadBalancerSourceRanges: [<allowed VNet subnet CIDRs>]")].join("\n"),
      }],
    });
    for (const g of group) g.row.combos.find((k) => k.type === "vnet")!.issueId = id;
  }

  // ⑤ Standing high privilege (no takeover chain) — one grouped issue
  const standing = user.filter((x) => x.row.combos.some((k) => k.type === "standing"));
  if (standing.length) {
    const id = "standing";
    const findingIds = rbacFindings(standing.flatMap((s) => s.row.bindings));
    const top = standing.slice(0, 4);
    issues.push({
      id, sev: "warn", kind: "standing",
      title: L(`상시 고권한 서비스 계정 ${standing.length}개 — ${standing.map((s) => `${s.row.name}(${[...new Set(s.rbac.flatMap((b) => b.keys))].map((k) => riskLabel(k)).join("·")})`).join(", ")}`, `${standing.length} standing high-privilege service accounts — ${standing.map((s) => `${s.row.name}(${[...new Set(s.rbac.flatMap((b) => b.keys))].map((k) => riskLabel(k)).join("·")})`).join(", ")}`),
      owner: [...new Set(standing.map((s) => s.row.owner))].join(" · "), ownerGroup: "addon", findingIds, extraEvidence: [],
      nodes: [
        ...top.map((s, i): AttackNode => ({ id: `w${i}`, col: 1, row: i, type: "workload", label: s.row.name, sub: s.row.owner, facts: workloadFacts(s), refs: [s.row.id] })),
        ...top.map((s, i): AttackNode => ({ id: `p${i}`, col: 3, row: i, type: s.rbac.every((b) => b.keys.every((k) => k === "secrets")) ? "secret" : "permission", label: [...new Set(s.rbac.flatMap((b) => b.keys))].map((k) => riskLabel(k)).join(" · "), sub: s.row.bindings.join(", "), facts: s.rbac.flatMap((b) => [{ k: L("바인딩", "Binding"), v: `${b.kind} ${b.binding} → ${b.role}`, ev: "perm" as EvidenceKind, mono: true }, { k: L("규칙", "Rules"), v: b.rules.join(" | "), ev: "perm" as EvidenceKind, mono: true }]), refs: [s.row.id], cmd: saCmd(s) })),
        { id: "impact", col: 4, row: Math.floor((top.length - 1) / 2), type: "impact", label: L("클러스터 자격증명·정책", "Cluster credentials · policies"), sub: L("상시 노출된 고권한", "Standing high privilege"), facts: [{ k: L("성격", "Nature"), v: L("사용 시점과 무관하게 토큰이 권한을 가짐", "The token holds the permissions regardless of when it is used"), ev: "perm" }], refs: [] },
      ],
      edges: [
        ...top.map((s, i): AttackEdge => ({ from: `w${i}`, to: `p${i}`, ev: "perm", label: s.row.bindings.join(", "), cut: `${id}:${s.row.id}` })),
        ...top.map((_, i): AttackEdge => ({ from: `p${i}`, to: "impact", ev: "perm", label: "" })),
      ],
      actions: standing.map((s): RemediationAction => ({
        id: `${id}:${s.row.id}`, title: L(`${s.row.name} 권한 축소`, `Reduce permissions of ${s.row.name}`), desc: s.row.owner.startsWith("Helm") ? L("Helm values의 rbac/collectors 항목에서 제거해야 업그레이드 후에도 유지됩니다.", "Remove them in the Helm values (rbac/collectors) so the change survives upgrades.") : L("필요한 리소스·동사만 남기세요.", "Keep only the resources and verbs you need."),
        risk: "ok", riskLabel: L("안전", "Safe"), closes: rbacFindings(s.row.bindings), cuts: [`w${top.indexOf(s)}>p${top.indexOf(s)}`].filter((x) => !x.includes("-1")), effect: "closed",
        code: rbacReduceCode(s, [...new Set(s.rbac.flatMap((b) => b.keys))]),
      })),
    });
    for (const s of standing) s.row.combos.find((k) => k.type === "standing")!.issueId = id;
  }
  const order = { local: 0, exfil: 1, takeover: 2, vnet: 3, standing: 4 } as const;
  return issues.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "crit" ? -1 : 1) || order[a.kind] - order[b.kind]);
}

// ── RBAC matrix ──

function buildMatrix(input: InsightsInput, ctxs: RowCtx[]): RbacMatrixRow[] {
  const { inventory: inv, policy } = input;
  const system = new Map(policy.rbac.bindings.map((b) => [`${b.kind}/${b.namespace ?? ""}/${b.name}`, b.system]));
  return inv.bindings
    .filter((b) => !system.get(`${b.kind}/${b.namespace ?? ""}/${b.name}`))
    .map((b) => {
      const r = rbacRiskKeys(roleRules(inv, b.roleRef, b.namespace), b.roleRef.name);
      const saRow = b.subjects
        .filter((s) => s.kind === "ServiceAccount")
        .map((s) => ctxs.find((c) => c.row.namespace === (s.namespace ?? b.namespace) && c.row.serviceAccount === s.name && !c.row.managed)?.row.id)
        .find(Boolean) ?? null;
      return {
        binding: b.name, kind: b.kind, ...(b.namespace ? { namespace: b.namespace } : {}), role: b.roleRef.name,
        subjects: b.subjects.map((s) => `${s.kind}:${s.namespace ? `${s.namespace}/` : ""}${s.name}`),
        workloadId: saRow, keys: r.keys, conditional: r.conditional, rules: r.rules,
      };
    })
    .filter((m) => m.keys.length)
    .sort((a, b) => b.keys.filter((k) => GRADE[k] === "crit").length - a.keys.filter((k) => GRADE[k] === "crit").length || b.keys.length - a.keys.length);
}

// ── Entry point ──

export function buildPolicyInsights(input: InsightsInput): PolicyInsightsResponse {
  // Workloads that run at least one pod (replicas 0 / Windows DaemonSets on Linux-only clusters excluded)
  const workloads = input.inventory.workloads.filter((w) => w.replicas > 0);
  const ctxs = buildRows(input, workloads);
  const rowById = new Map(ctxs.map((c) => [c.row.id, c.row]));
  const network = buildNetwork(input, workloads, rowById);
  // Observed traffic leaving the cluster (API server excluded — normal for controllers)
  for (const c of ctxs) {
    const out = network.edges.filter((e) => e.from === c.row.id && (e.cls === "cloud" || e.cls === "internet"));
    if (out.length) {
      c.row.cells.extEgress = out.map((e) => `${network.nodes.find((n) => n.id === e.to)?.label ?? e.to} ${e.ports.join(",")} ×${e.count}`).join(" · ");
      c.row.weights.extEgress = "warn";
    }
  }
  for (const c of ctxs) {
    c.row.combos = combosOf(c.row.cells, c.row.weights);
    c.row.score = factors().reduce((s, f) => s + (c.row.cells[f.key] ? WEIGHT_SCORE[c.row.weights[f.key] ?? f.weight] : 0), 0);
  }
  // Workload nodes of the network map carry their combos
  for (const n of network.nodes) if (n.kind === "workload") n.combos = rowById.get(n.id)?.combos.map((x) => x.type) ?? [];
  const matrix = buildMatrix(input, ctxs);
  const issues = buildIssues(input, ctxs, network);
  for (const n of network.nodes) if (n.kind === "workload") n.combos = rowById.get(n.id)?.combos.map((x) => x.type) ?? [];
  const rows = ctxs.map((c) => c.row).sort((a, b) => b.combos.length - a.combos.length || b.score - a.score || a.id.localeCompare(b.id));
  return {
    clusterId: input.clusterId,
    generatedAt: (input.now ?? new Date()).toISOString(),
    factors: factors(),
    rows,
    riskDict: riskDict(),
    matrix,
    issues,
    network,
    containment: {
      ...input.containment,
      resources: network.nodes.filter((n) => n.kind === "paas").map((n) => {
        // Same key as the network node id (ARM type + name) — a name-only match could pick another type's RG
        const same = input.azure.endpoints.filter((x) => `azure:${x.type}/${x.name}` === n.id);
        const a = same.length === 1 ? same[0] : undefined;
        return { id: n.id, name: n.label, type: n.azureType ?? "", armType: a?.armType ?? n.id.slice("azure:".length).split("/")[0] ?? "", resourceGroup: a?.resourceGroup ?? "" };
      }),
    },
    kbom: buildKbom(workloads, input),
    gaps: input.gaps,
  };
}

