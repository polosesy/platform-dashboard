export type AzureSubscriptionOption = {
  subscriptionId: string;
  name?: string;
  /** Azure connection this subscription belongs to (several connections → the selector groups by it) */
  connectionKey?: string;
  connectionName?: string;
};

export type AzureSubscriptionsResponse = {
  generatedAt: string;
  subscriptions: AzureSubscriptionOption[];
  note?: string;
};


/**
 * Why an in-cluster connection (Loki · Hubble UI) was not made — from the socket error's code, measured from the
 * dashboard pod (stg, 2026-11-18): dns = ENOTFOUND / EAI_AGAIN (the name does not resolve) · refused = ECONNREFUSED
 * (Cilium answers at once for a Service with no ready pod — e.g. Loki restarting; or nothing listens) · timeout =
 * the connect timed out (a network policy drops it, or a port the Service does not expose — the two look the same) ·
 * noRoute = EHOSTUNREACH / ENETUNREACH. Absent = the error carried none of these codes.
 */
export type ConnectCause = "dns" | "refused" | "timeout" | "noRoute";
