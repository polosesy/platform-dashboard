// 설정 › 보기 설정 — pure view helpers (tested in viewPrefs.test.ts).
import type { AzureConnectionOption, AzureSubscriptionOption, CloudProvider } from "@aud/types";

/** What each cloud calls the scope a reader works in (packages/types cloud.ts ScopeRef kinds) */
export const PROVIDER_SCOPE: Record<CloudProvider, "subscription" | "account" | "project"> = { azure: "subscription", aws: "account", gcp: "project" };

export type DirectoryRow = { key: string; name: string; directory: string; idTail: string; mode: AzureConnectionOption["mode"]; subscriptions: number };

/**
 * Pure: the Azure directories (tenants) the platform reads — one row per connection the caller's role reaches; the
 * directory = the declared tenant name, else the connection's name; subscriptions = the ones listed for it (the API's
 * count when none is listed yet)
 */
export function directoriesOf(connections: AzureConnectionOption[], subs: AzureSubscriptionOption[]): DirectoryRow[] {
  return connections.filter((c) => (c.provider ?? "azure") === "azure").map((c) => {
    const listed = subs.filter((s) => s.connectionKey === c.key).length;
    return { key: c.key, name: c.displayName, directory: c.tenantName ?? c.displayName, idTail: c.tenantIdTail, mode: c.mode, subscriptions: listed || c.subscriptionCount };
  });
}

/** Pure: a language's own name (한국어 · English) — from Intl, not a literal in the code */
export function languageName(l: "ko" | "en"): string {
  try { return new Intl.DisplayNames([l], { type: "language" }).of(l) ?? l; } catch { return l; }
}
