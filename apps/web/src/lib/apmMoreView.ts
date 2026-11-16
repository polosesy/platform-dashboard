// 서비스 (APM) › 오류 · 배포 and RED's "a week earlier" — view helpers (pure). Facts side by side; no colour, no verdict.

import type { AppErrorSeries, Rollout } from "@aud/types";

const HEX64 = /^[0-9a-f]{64}$/;
/**
 * The image as a version people can compare: the tag, plus the digest's first 8 when the image is pinned ("latest ·
 * 4b4ec230" — stg 2026-11-16: 44 app pods run `:latest@sha256:…`, so only the digest tells two versions apart).
 * "reg/repo:1.2.3" → "1.2.3" · "reg/repo:1.2.3@sha256:4b4e…" → "1.2.3 · 4b4ec230" · "reg/repo@sha256:…" → "sha256 · 4b4ec230"
 * · the status form "repo:<64 hex>" → "sha256 · 4b4ec230"
 */
export function imageTag(image: string): string {
  const at = image.indexOf("@");
  const digest = at >= 0 ? image.slice(at + 1).replace(/^sha256:/, "").slice(0, 8) : null;
  const name = at >= 0 ? image.slice(0, at) : image;
  const slash = name.lastIndexOf("/"), colon = name.lastIndexOf(":");
  const tag = colon > slash ? name.slice(colon + 1) : null;
  if (tag && HEX64.test(tag)) return `sha256 · ${tag.slice(0, 8)}`;
  if (digest) return `${tag ?? "sha256"} · ${digest}`;
  return tag ?? "latest";
}
/** The repository without registry and tag — "reg.io/team/app:1" → "team/app" */
export function imageRepo(image: string): string {
  const noDigest = image.split("@")[0]!;
  const slash = noDigest.lastIndexOf("/"), colon = noDigest.lastIndexOf(":");
  const repo = colon > slash ? noDigest.slice(0, colon) : noDigest;
  const parts = repo.split("/");
  return parts.length > 1 && /[.:]/.test(parts[0]!) ? parts.slice(1).join("/") : repo;
}

export type ImageChange = { container: string; from: string | null; to: string | null; changed: boolean };
/** Pure: per container, the image before → now (null = not known / not running); changed when the images differ */
export function imageChanges(r: Pick<Rollout, "images" | "previousImages">): ImageChange[] {
  const before = new Map((r.previousImages ?? []).map((x) => [x.container, x.image]));
  const now = new Map(r.images.map((x) => [x.container, x.image]));
  const names = [...new Set([...before.keys(), ...now.keys()])].sort();
  return names.map((c) => ({ container: c, from: before.get(c) ?? null, to: now.get(c) ?? null, changed: (before.get(c) ?? null) !== (now.get(c) ?? null) }));
}

/** Pure: ratio of now to a week earlier ("×1.8", "×0.4"), null when either side is missing or zero */
export function ratioText(now: number | null | undefined, before: number | null | undefined): string | null {
  if (now == null || before == null || !(before > 0)) return null;
  const r = now / before;
  return `×${r >= 10 ? Math.round(r) : r.toFixed(r < 1 ? 2 : 1)}`;
}

/** Pure: the days' bars as heights 0–100 (of the busiest day of this app); all zero = an empty row */
export function dailyBars(a: Pick<AppErrorSeries, "daily">): Array<{ day: string; errors: number; height: number }> {
  const max = Math.max(0, ...a.daily.map((d) => d.errors));
  return a.daily.map((d) => ({ ...d, height: max > 0 ? Math.max(d.errors > 0 ? 6 : 0, Math.round((d.errors / max) * 100)) : 0 }));
}

/** Pure: totals for the errors view's headline */
export function errorTotals(apps: AppErrorSeries[]): { apps: number; withErrors: number; errors: number; warn: number; isNew: number } {
  return {
    apps: apps.length, withErrors: apps.filter((a) => (a.error ?? 0) + (a.fatal ?? 0) > 0).length,
    errors: apps.reduce((n, a) => n + (a.error ?? 0) + (a.fatal ?? 0), 0), warn: apps.reduce((n, a) => n + (a.warn ?? 0), 0),
    isNew: apps.filter((a) => a.newIn24h).length,
  };
}
