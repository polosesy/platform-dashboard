// 네트워크 › 네트워크 경로 — device-measured paths to SaaS endpoints (services/netPath.ts). Read and upload: signed-in users
// (a user measures from their own device); delete: operators. The dashboard never probes anything itself.
import type { Request, Response, Router } from "express";
import { z } from "zod";
import type { Env } from "../env.js";
import type { NetPathResponse } from "@aud/types";
import { callerOf, requireRole, roleAtLeast } from "../infra/platformAccess.js";
import { sendError } from "../infra/requestParams.js";
import { MAX_UPLOAD_BYTES, addRun, deleteRun, netPathDir, readRuns } from "../services/netPath.js";

const Upload = z.object({ text: z.string().min(2).max(MAX_UPLOAD_BYTES), device: z.string().max(64).optional() }).strict();
const PARSE_ERRORS = new Set(["netpath_too_large", "netpath_not_json", "netpath_unknown_format"]);

export function registerNetPathRoutes(router: Router, env: Env) {
  const dir = netPathDir(env);

  router.get("/api/netpath", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.json({ signedIn: false, durable: !!dir, canDelete: false, runs: [] } satisfies NetPathResponse);
      const canDelete = roleAtLeast(callerOf(env, req.auth.bearerToken)?.role ?? null, "operator");
      res.json({ signedIn: true, durable: !!dir, canDelete, runs: await readRuns(dir) } satisfies NetPathResponse);
    } catch (e: unknown) {
      sendError(res, e, "netpath_read_failed");
    }
  });

  router.post("/api/netpath/runs", async (req: Request, res: Response) => {
    try {
      if (req.auth?.kind !== "user") return res.status(401).json({ error: "signin_required" });
      const body = Upload.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "netpath_invalid" });
      try {
        const run = await addRun(dir, body.data.text, { by: req.auth.principal.name, ...(body.data.device ? { device: body.data.device } : {}) });
        res.status(201).json(run);
      } catch (e: unknown) {
        const code = e instanceof Error ? e.message : "";
        if (PARSE_ERRORS.has(code)) return res.status(400).json({ error: code });
        throw e;
      }
    } catch (e: unknown) {
      sendError(res, e, "netpath_write_failed");
    }
  });

  router.delete("/api/netpath/runs", requireRole(env, "operator"), async (req: Request, res: Response) => {
    try {
      const id = typeof req.query.id === "string" && /^[0-9a-f-]{36}$/.test(req.query.id) ? req.query.id : null;
      if (!id) return res.status(400).json({ error: "netpath_id_invalid" });
      if (!(await deleteRun(dir, id))) return res.status(404).json({ error: "netpath_not_found" });
      res.status(204).end();
    } catch (e: unknown) {
      sendError(res, e, "netpath_write_failed");
    }
  });
}
