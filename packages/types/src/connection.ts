// Platform sign-in (SSO roles) and Azure connections — how the platform reads each customer's Azure.
// No GUIDs leave the API: connections are named by key and display name only.

/** Platform role from the token's app roles (AUD.Viewer / AUD.Operator / AUD.Admin) — the highest one wins */
export type PlatformRole = "viewer" | "operator" | "admin";

/**
 * platform          the platform's own identity (its app registration's service principal) in the home tenant
 * lighthouse        a customer tenant delegated to the home tenant with Azure Lighthouse — read with the home credential
 * servicePrincipal  a service principal the customer created and handed over (secret in an env var, or a certificate)
 * delegated         each signed-in user's own Azure permissions (OBO) — opt-in, never mixed with the others
 */
export type ConnectionMode = "platform" | "lighthouse" | "servicePrincipal" | "delegated";

export type ConnectionCheckStatus = "ok" | "warning" | "failed";

export type AzureConnectionOption = {
  key: string;
  displayName: string;
  mode: ConnectionMode;
  subscriptionCount: number;
  workspaceCount: number;
  lastCheck?: { at: string; status: ConnectionCheckStatus };
};

export type AzureConnectionsResponse = { generatedAt: string; connections: AzureConnectionOption[] };

/** GET /api/me — who the platform thinks you are */
export type MeResponse = {
  anonymous: boolean;
  name?: string;
  role: PlatformRole | null;
  /** The role came from AUD_DEFAULT_ROLE (no app role assigned to this user yet) */
  roleFromDefault?: boolean;
  connections: AzureConnectionOption[];
};

/** Feature → the permission it needs, checked per subscription */
export type ConnectionFeature = "inventory" | "metrics" | "logs" | "security" | "cost" | "aksCredential" | "flowLogBlobs" | "prometheus";
export type FeatureStatus = "ok" | "missing" | "unknown";
/** More than read access — a warning, never a block */
export type PrivilegeWarning = "wildcard" | "write_or_delete" | "role_assignment_write" | "cluster_admin_credential";

/** GET /api/azure/connections/:key/check (admin) — run with the connection's own credential */
export type ConnectionCheckResponse = {
  generatedAt: string;
  connection: AzureConnectionOption;
  status: ConnectionCheckStatus;
  token: { ok: boolean; code?: string };
  /** Declared subscriptions vs what the credential can see (counts only) */
  visible: { declared: number; visible: number; missing: number; extra: number } | null;
  subscriptions: Array<{
    /** Display name, or the masked id (…1234) */
    label: string;
    reachable: boolean;
    features: Record<ConnectionFeature, FeatureStatus>;
    warnings: PrivilegeWarning[];
    error?: string;
  }>;
  workspaces: Array<{ label: string; ok: boolean; code?: string }>;
};
