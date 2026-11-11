// AKS 모니터링 › SLO › 설정 — the form behind the platform's SLO settings (pure).
//
// A draft holds strings (what the fields show): "" = inherit — the field is left out of the saved settings, so the
// next source decides (API workloadSlo `targetsFor`, mirrored here by `inherited` for the hints): a service's platform
// value › the service's file value › the cluster's platform value › the file's top level › the defaults. A latency
// target is a pair (threshold + target): setting one half fills the other from what it would inherit. A reset counts
// one service's (or every service's) error budget from a time; it ends when it leaves the window.

import type { SloBudgetReset, SloService, SloSettings, SloSettingsResponse, SloTargetsSetting } from "@aud/types";

/** The usual targets (the API's SLO_TIERS) */
export const TARGET_TIERS = [0.9, 0.95, 0.99, 0.995, 0.999, 0.9995, 0.9999] as const;
export const WINDOW_DAYS = [7, 14, 28, 30] as const;
const SERVICE_KEY = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\/[\w.-]{1,128}$/;

export type TargetsDraft = { availability: string; thresholdMs: string; latencyTarget: string; excludeUris: string };
export type ServiceDraft = TargetsDraft & { exclude: boolean };
export type SettingsDraft = TargetsDraft & { windowDays: string; services: Record<string, ServiceDraft> };

export const EMPTY_TARGETS: TargetsDraft = { availability: "", thresholdMs: "", latencyTarget: "", excludeUris: "" };
export const EMPTY_SERVICE: ServiceDraft = { ...EMPTY_TARGETS, exclude: false };

const num = (v: number | undefined) => (v === undefined ? "" : String(v));
const targetsDraft = (t: SloTargetsSetting | undefined): TargetsDraft => ({
  availability: num(t?.availability),
  thresholdMs: num(t?.latency?.thresholdMs),
  latencyTarget: num(t?.latency?.target),
  excludeUris: (t?.excludeUris ?? []).join("\n"),
});

/** Pure: the form for saved settings */
export function draftOf(s: SloSettings): SettingsDraft {
  const services: Record<string, ServiceDraft> = {};
  for (const [k, v] of Object.entries(s.services ?? {})) services[k] = { ...targetsDraft(v), exclude: v.exclude === true };
  return { ...targetsDraft(s), windowDays: num(s.windowDays), services };
}

type Source = "platform" | "config" | "default";
export type Inherited = { availability: { v: number; source: Source }; latency: { v: { thresholdMs: number; target: number }; source: Source } };

/**
 * Pure: what a field would be if left empty — for the cluster's fields (`key` omitted): the file's top level › the
 * defaults; for a service's: the file's service entry › the cluster's platform value › the file's top level › defaults
 */
export function inherited(r: Pick<SloSettingsResponse, "file" | "defaults">, platform: SloSettings, key?: string): Inherited {
  const fileSvc = key ? r.file?.services?.[key] : undefined;
  const chain: Array<[SloTargetsSetting | undefined, Source]> = key
    ? [[fileSvc, "config"], [platform, "platform"], [r.file ?? undefined, "config"]]
    : [[r.file ?? undefined, "config"]];
  const pick = <T>(f: (x: SloTargetsSetting | undefined) => T | undefined, d: T): { v: T; source: Source } => {
    for (const [x, source] of chain) { const v = f(x); if (v !== undefined) return { v, source }; }
    return { v: d, source: "default" };
  };
  return { availability: pick((x) => x?.availability, r.defaults.availability), latency: pick((x) => x?.latency, r.defaults.latency) };
}

/** Pure: the window that applies when the field is empty */
export function inheritedWindow(r: Pick<SloSettingsResponse, "file" | "defaults">): { v: number; source: Source } {
  return r.file?.windowDays ? { v: r.file.windowDays, source: "config" } : { v: r.defaults.windowDays, source: "default" };
}

export type DraftError = { field: string; code: "threshold" | "target" | "uri" | "serviceKey" };

const parseTarget = (v: string): number | null | undefined => {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.5 && n <= 0.99999 ? n : null;
};
const parseThreshold = (v: string): number | null | undefined => {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 120_000 ? n : null;
};
const parseUris = (v: string): string[] | null => {
  const list = [...new Set(v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
  return list.length > 50 || list.some((x) => x.length > 300) ? null : list;
};

function targetsOf(d: TargetsDraft, inh: Inherited, field: string, errors: DraftError[]): SloTargetsSetting {
  const out: SloTargetsSetting = {};
  const av = parseTarget(d.availability);
  if (av === null) errors.push({ field: `${field}.availability`, code: "target" });
  else if (av !== undefined) out.availability = av;
  const th = parseThreshold(d.thresholdMs);
  const lt = parseTarget(d.latencyTarget);
  if (th === null) errors.push({ field: `${field}.thresholdMs`, code: "threshold" });
  if (lt === null) errors.push({ field: `${field}.latencyTarget`, code: "target" });
  if (th !== null && lt !== null && (th !== undefined || lt !== undefined)) {
    out.latency = { thresholdMs: th ?? inh.latency.v.thresholdMs, target: lt ?? inh.latency.v.target };
  }
  const uris = parseUris(d.excludeUris);
  if (uris === null) errors.push({ field: `${field}.excludeUris`, code: "uri" });
  else if (uris.length) out.excludeUris = uris;
  return out;
}

/**
 * Pure: the settings a draft saves, or the fields that are wrong — empty fields and service rows with nothing set are
 * left out (inherit), so a cleared form saves `{}`
 */
export function settingsOf(d: SettingsDraft, r: Pick<SloSettingsResponse, "file" | "defaults">): { settings: SloSettings; errors: DraftError[] } {
  const errors: DraftError[] = [];
  const top = targetsOf(d, inherited(r, {}), "cluster", errors);
  const settings: SloSettings = { ...top };
  const w = Number(d.windowDays);
  if (d.windowDays && (WINDOW_DAYS as readonly number[]).includes(w)) settings.windowDays = w as SloSettings["windowDays"];
  const services: NonNullable<SloSettings["services"]> = {};
  for (const [k, v] of Object.entries(d.services)) {
    if (!SERVICE_KEY.test(k)) { errors.push({ field: k, code: "serviceKey" }); continue; }
    const t = targetsOf(v, inherited(r, settings, k), k, errors);
    const e = { ...t, ...(v.exclude ? { exclude: true } : {}) };
    if (Object.keys(e).length) services[k] = e;
  }
  if (Object.keys(services).length) settings.services = services;
  return { settings, errors };
}

/** Pure: whether two settings are the same (key order does not matter) */
export function sameSettings(a: SloSettings, b: SloSettings): boolean {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).sort(([p], [q]) => (p < q ? -1 : 1)).map(([k, v]) => [k, norm(v)]))
    : x;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Pure: the services the table lists — measured ones first (as the SLO view orders them), then names only in the settings or the file */
export function serviceRows(measured: SloService[], r: Pick<SloSettingsResponse, "file" | "settings">): Array<{ key: string; measured: SloService | null }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; measured: SloService | null }> = [];
  for (const s of measured) {
    const key = `${s.namespace}/${s.application}`;
    if (!s.application || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, measured: s });
  }
  const extra = [...Object.keys(r.settings.services ?? {}), ...Object.keys(r.file?.services ?? {})].filter((k) => !seen.has(k));
  for (const key of [...new Set(extra)].sort()) out.push({ key, measured: null });
  return out;
}

/** Pure: a reset's state at `now` — it counts until it leaves the window (at + window) */
export function resetState(x: SloBudgetReset, now: number, windowDays: number): { active: boolean; endsAt: number; future: boolean } {
  const at = Date.parse(x.at);
  const endsAt = at + windowDays * 86_400_000;
  return { active: at <= now && now < endsAt, endsAt, future: at > now };
}

/** Pure: a datetime-local value (the viewer's clock) → ISO, or null when empty / unreadable */
export function localToIso(v: string): string | null {
  if (!v.trim()) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Pure: the hours since a reset as "n일 m시간" parts */
export function spanParts(hours: number): { days: number; hours: number } {
  const h = Math.max(0, Math.floor(hours));
  return { days: Math.floor(h / 24), hours: h % 24 };
}

/** "n일 m시간" / "m시간" (under a day) in the app's language — `t` = the i18n function */
export function spanLabel(t: (k: string, v?: Record<string, string | number>) => string, hours: number): string {
  const p = spanParts(hours);
  return p.days ? t("ob.slo.span.dh", p) : t("ob.slo.span.h", p);
}
