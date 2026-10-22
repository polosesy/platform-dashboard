"use client";

import { useCallback, useState } from "react";
import { apiUrl, fetchJsonWithBearer, ApiError } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { parseArrangement, serializeArrangement, type Arrangement } from "@/lib/archArrange";

export type TeamInfo = { version: number; updatedAt: string; updatedBy?: string; durable: boolean };
type Doc = { v: 1 | 2; version: number; updatedAt: string; updatedBy?: string; order: Array<[string, string[]]>; grid?: unknown[]; lines: unknown[] };

/**
 * The team layout of a subscription (API /api/architecture/arrangement): load it into this browser's edit, or
 * publish this browser's edit as the team layout (operators). A publish names the version it started from; when
 * someone published in between, the API answers 409 and the user chooses to load theirs or overwrite.
 */
export function useTeamArrangement(subscriptionId: string) {
  const getToken = useApiToken();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const toArrangement = (doc: Doc): Arrangement => parseArrangement(JSON.stringify({ v: doc.grid?.length ? 2 : 1, order: doc.order, grid: doc.grid ?? [], lines: doc.lines }));

  const load = useCallback(async (): Promise<Arrangement | null> => {
    setBusy(true);
    try {
      const token = await getToken().catch(() => null);
      const r = await fetchJsonWithBearer<{ doc: Doc | null; durable: boolean }>(apiUrl("/api/architecture/arrangement", { subscriptionId: subscriptionId || undefined }), token);
      setConflict(false);
      if (!r.doc) { setTeam(null); return null; }
      setTeam({ version: r.doc.version, updatedAt: r.doc.updatedAt, ...(r.doc.updatedBy ? { updatedBy: r.doc.updatedBy } : {}), durable: r.durable });
      return toArrangement(r.doc);
    } finally {
      setBusy(false);
    }
  }, [getToken, subscriptionId]);

  /** Publish; returns "ok", "conflict" (someone else published since `team.version`), or throws */
  const publish = useCallback(async (a: Arrangement, force = false): Promise<"ok" | "conflict"> => {
    setBusy(true);
    try {
      const token = await getToken().catch(() => null);
      const body = { ...JSON.parse(serializeArrangement(a)) as object, baseVersion: team?.version ?? null };
      const r = await fetchJsonWithBearer<{ doc: Doc; durable: boolean }>(
        apiUrl("/api/architecture/arrangement", { subscriptionId: subscriptionId || undefined, ...(force ? { force: "1" } : {}) }),
        token,
        { method: "PUT", body: JSON.stringify(body) },
      );
      setTeam({ version: r.doc.version, updatedAt: r.doc.updatedAt, ...(r.doc.updatedBy ? { updatedBy: r.doc.updatedBy } : {}), durable: r.durable });
      setConflict(false);
      return "ok";
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setConflict(true); return "conflict"; }
      throw e;
    } finally {
      setBusy(false);
    }
  }, [getToken, subscriptionId, team?.version]);

  return { team, busy, conflict, load, publish };
}
