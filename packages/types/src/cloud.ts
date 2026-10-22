// Multi-cloud seams (Phase 0 — docs/architecture/multi-cloud.md): provider-neutral names for scopes, resources and
// what kind of thing a resource is. Types only — this package must not carry runtime values (the image build checks
// that the API never imports it at run time); the mapping data lives in apps/api/src/services/cloudKinds.ts.

export type CloudProvider = "azure" | "aws" | "gcp";

/** The domains of the canonical taxonomy (the reference map in docs/image/aws-azure-gcp-system.gif, plus network,
 *  security and the account / project scope) */
export type CanonicalDomain =
  | "scope" | "compute" | "container" | "serverless" | "db" | "storage" | "messaging" | "network" | "security"
  | "observability" | "ai" | "other";

/** What a resource is, across providers — classified by function, not by its row in a comparison picture
 *  (e.g. AlloyDB is db.relational). Launch modes and tiers (Fargate, Autopilot, Archive) are facets, not kinds */
export type CanonicalKind =
  | "scope.account" | "scope.group"
  | "compute.vm" | "compute.scaleSet" | "compute.appPlatform"
  | "container.cluster" | "container.service" | "container.registry"
  | "serverless.function" | "serverless.workflow" | "serverless.apiGateway"
  | "db.relational" | "db.nosql" | "db.document" | "db.cache"
  | "storage.object" | "storage.block" | "storage.file"
  | "messaging.queue" | "messaging.topic" | "messaging.stream" | "messaging.eventRouter"
  | "network.vnet" | "network.subnet" | "network.securityGroup" | "network.nic" | "network.lb" | "network.l7lb"
  | "network.edge" | "network.dnsTraffic" | "network.firewall" | "network.nat" | "network.publicIp"
  | "network.privateEndpoint" | "network.dns" | "network.vpnGateway" | "network.bastion"
  | "security.secrets"
  | "observability.apm" | "observability.logs" | "observability.metricsWorkspace" | "observability.dashboards"
  | "ai.platform" | "ai.ml" | "ai.search"
  | "other";

/** azure: subscription GUID · aws: 12-digit account · gcp: project id (not the number) */
export type ScopeRef = { provider: CloudProvider; kind: "subscription" | "account" | "project"; id: string };

/** id = ARM id | ARN | Cloud Asset Inventory full name (//compute.googleapis.com/projects/p/zones/z/instances/i) */
export type ResourceRef = { provider: CloudProvider; id: string; scope: ScopeRef; nativeType: string; kind?: CanonicalKind };

/** One canonical kind and the native types that are it, per provider (lower-case ARM type, CloudFormation type
 *  name, CAI asset type). `discriminator` = what tells it apart when one native type covers several kinds;
 *  `gap` = a provider with no equivalent, and why */
export type NativeTypeMapping = {
  kind: CanonicalKind;
  azure?: string[];
  aws?: string[];
  gcp?: string[];
  discriminator?: string;
  gap?: Partial<Record<CloudProvider, string>>;
};
