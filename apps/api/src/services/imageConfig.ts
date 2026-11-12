// 앱 런타임 — the image's own configuration, read from the registry (Azure Container Registry only). The config blob
// of an image (a few KB — never a layer) states what the image runs and with which runtime version:
//   Env         JAVA_VERSION · NODE_VERSION · PYTHON_VERSION · DOTNET_VERSION / ASPNET_VERSION · GOLANG_VERSION ·
//               NGINX_VERSION · REDIS_VERSION · PG_VERSION / PG_MAJOR — the variables the official base images set
//   Entrypoint  the executable the image starts (the same reading as a manifest's `command`)
//   Labels      org.opencontainers.image.source / revision / base.name (where it was built from)
// Only the names above are read out of Env — no other variable's name or value leaves this module.
//
// Opt-in per connection (`aks.imageConfig: true`) + the connection's identity needs AcrPull on the registry. Flow:
// Entra token (ARM audience) → /oauth2/exchange → /oauth2/token (repository:<repo>:pull) → manifest (an index is
// followed to linux/amd64) → config blob. Hosts are `<name>.azurecr.io` only; a blob redirect is followed only to
// Azure's own data endpoints, without the Authorization header.

import type { AppRuntimeKind } from "@aud/types";
import type { Env } from "../env.js";
import { CacheManager } from "../infra/cacheManager.js";
import { clusterConnection, connectionToken } from "../infra/azureClientFactory.js";
import { imageParts } from "./imageVulns.js";
import { executableOf } from "./runtimeEvidence.js";

export type ImageConfigFacts = {
  runtimes: Array<{ kind: AppRuntimeKind; version?: string; evidence: string }>;
  source?: string; revision?: string; baseImage?: string; created?: string;
};
export type ImageConfigState = "ok" | "off" | "forbidden" | "unreachable" | "failed" | "none";

const ACR_HOST = /^[a-z0-9]{5,50}\.azurecr\.io$/;
const REDIRECT_HOST = /^([a-z0-9-]+\.)+(azurecr\.io|blob\.core\.windows\.net|blob\.storage\.azure\.net)$/;
const ENV_RUNTIME: Array<[RegExp, AppRuntimeKind]> = [
  [/^(JAVA_VERSION|JAVA_HOME)$/, "jvm"], [/^NODE_VERSION$/, "nodejs"], [/^PYTHON_VERSION$/, "python"],
  [/^(DOTNET_VERSION|ASPNET_VERSION|ASPNETCORE_VERSION|DOTNET_RUNNING_IN_CONTAINER)$/, "dotnet"], [/^GOLANG_VERSION$/, "go"],
  [/^NGINX_VERSION$/, "nginx"], [/^(REDIS_VERSION|VALKEY_VERSION)$/, "redis"], [/^(PG_VERSION|PG_MAJOR)$/, "postgres"],
];
const EXE_RUNTIME: Array<[RegExp, AppRuntimeKind]> = [
  [/^java$/, "jvm"], [/^(node|nodejs)$/, "nodejs"], [/^(python|python\d(\.\d+)?|gunicorn|uvicorn)$/, "python"], [/^dotnet$/, "dotnet"],
  [/^(nginx|openresty)$/, "nginx"], [/^(redis-server|valkey-server)$/, "redis"], [/^(postgres|postmaster)$/, "postgres"],
];
const versionOf = (v: string): string | undefined => /(\d+(?:\.\d+){0,3})/.exec(v)?.[1];
const label = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 300 && !/[\s@]|:\/\/[^/]*:[^/]*@/.test(v.replace(/^https?:\/\//, "")) ? v : undefined);

/** Pure: an OCI image config → what it runs. Only the variables in ENV_RUNTIME are looked at. */
export function factsOfImageConfig(config: unknown): ImageConfigFacts {
  const c = (config ?? {}) as { created?: unknown; config?: { Env?: unknown; Entrypoint?: unknown; Cmd?: unknown; Labels?: unknown } };
  const runtimes: ImageConfigFacts["runtimes"] = [];
  const add = (kind: AppRuntimeKind, evidence: string, version?: string) => {
    const hit = runtimes.find((r) => r.kind === kind);
    if (!hit) runtimes.push({ kind, evidence, ...(version ? { version } : {}) });
    else if (!hit.version && version) { hit.version = version; if (evidence.startsWith("image env:")) hit.evidence = evidence; }
  };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // what the image starts: its Entrypoint (Cmd only when there is no Entrypoint — otherwise Cmd is just arguments)
  const entry = strings(c.config?.Entrypoint);
  const exe = executableOf(entry.length ? entry : strings(c.config?.Cmd));
  const byExe = exe ? EXE_RUNTIME.find(([re]) => re.test(exe))?.[1] : undefined;
  if (byExe && exe) add(byExe, `entrypoint: ${exe}`);
  for (const e of strings(c.config?.Env)) {
    const i = e.indexOf("=");
    const name = i > 0 ? e.slice(0, i) : "";
    const kind = ENV_RUNTIME.find(([re]) => re.test(name))?.[1];
    if (!kind) continue;
    // JAVA_HOME / DOTNET_RUNNING_IN_CONTAINER name the runtime but carry no version
    const version = /VERSION|PG_MAJOR/.test(name) ? versionOf(e.slice(i + 1)) : undefined;
    add(kind, `image env: ${name}`, version);
  }
  const labels = (c.config?.Labels && typeof c.config.Labels === "object" ? c.config.Labels : {}) as Record<string, unknown>;
  const source = label(labels["org.opencontainers.image.source"]);
  const revision = label(labels["org.opencontainers.image.revision"]);
  const baseImage = label(labels["org.opencontainers.image.base.name"]);
  return {
    runtimes, ...(source ? { source } : {}), ...(revision ? { revision } : {}), ...(baseImage ? { baseImage } : {}),
    ...(typeof c.created === "string" ? { created: c.created } : {}),
  };
}

/**
 * Pure: the registry reference of a pod image when it is an Azure Container Registry — else null (never asked).
 * `imageId` = the container status's imageID (`<registry>/<repo>@sha256:…`). A pod pinned by digest reports its
 * image as a bare `sha256:…` (stg 2026-11-12: 30 of 36 registry images) — the repository is then only in imageID.
 */
export function acrRef(image: string, imageId?: string): { host: string; repo: string; ref: string } | null {
  const id = (imageId ?? "").replace(/^[a-z-]+:\/\//, "");                       // "docker-pullable://…" on old runtimes
  const named = image.includes("/") && !/^sha256:/.test(image);
  const p = imageParts(named ? image : id);
  if (!ACR_HOST.test(p.registry) || !/^[a-z0-9]+([._/-][a-z0-9]+)*$/.test(p.repo)) return null;
  // the digest that runs: imageID's when it names the same repository, else the image's own
  const idParts = id ? imageParts(id) : null;
  const d = idParts && idParts.registry === p.registry && idParts.repo === p.repo && idParts.digest ? idParts.digest : p.digest;
  const ref = /^sha256:[0-9a-f]{64}$/.test(d) ? d : /^[\w][\w.-]{0,127}$/.test(p.tag) ? p.tag : "";
  return ref ? { host: p.registry, repo: p.repo, ref } : null;
}

type Fetch = typeof fetch;
class RegistryError extends Error { constructor(readonly state: ImageConfigState, message: string) { super(message); } }
const MANIFEST_TYPES = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

async function call(doFetch: Fetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await doFetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(8_000) }); }
  catch (e) { throw new RegistryError("unreachable", e instanceof Error ? e.message : "no answer"); }
  if (res.status === 401 || res.status === 403) throw new RegistryError("forbidden", `registry ${res.status}`);
  return res;
}

/** The registry access token for one repository (pull) from an Entra token of the connection */
async function repoToken(doFetch: Fetch, host: string, repo: string, aadToken: string, tenantId: string): Promise<string> {
  const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
  const ex = await call(doFetch, `https://${host}/oauth2/exchange`, form({ grant_type: "access_token", service: host, tenant: tenantId, access_token: aadToken }));
  if (!ex.ok) throw new RegistryError("failed", `exchange ${ex.status}`);
  const refresh = ((await ex.json()) as { refresh_token?: string }).refresh_token ?? "";
  const tk = await call(doFetch, `https://${host}/oauth2/token`, form({ grant_type: "refresh_token", service: host, scope: `repository:${repo}:pull`, refresh_token: refresh }));
  if (!tk.ok) throw new RegistryError("failed", `token ${tk.status}`);
  return ((await tk.json()) as { access_token?: string }).access_token ?? "";
}

/** One image's config facts (manifest → config blob, ≤ 256 KB each) */
export async function readImageConfig(doFetch: Fetch, r: { host: string; repo: string; ref: string }, token: string): Promise<ImageConfigFacts> {
  const auth = { authorization: `Bearer ${token}` };
  const json = async (url: string, headers: Record<string, string>): Promise<unknown> => {
    let res = await call(doFetch, url, { headers });
    if (res.status === 307 || res.status === 302) {
      const to = new URL(res.headers.get("location") ?? "", url);
      if (to.protocol !== "https:" || !REDIRECT_HOST.test(to.hostname)) throw new RegistryError("failed", "redirect outside Azure");
      res = await call(doFetch, to.toString(), {});   // the data endpoint's URL is pre-signed — no Authorization
    }
    if (!res.ok) throw new RegistryError(res.status === 404 ? "none" : "failed", `registry ${res.status}`);
    const text = await res.text();
    if (text.length > 256_000) throw new RegistryError("failed", "larger than a config");
    return JSON.parse(text);
  };
  type Manifest = { config?: { digest?: string }; manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }> };
  let m = (await json(`https://${r.host}/v2/${r.repo}/manifests/${r.ref}`, { ...auth, accept: MANIFEST_TYPES })) as Manifest;
  if (m.manifests) {
    const pick = m.manifests.find((x) => x.platform?.os === "linux" && x.platform.architecture === "amd64") ?? m.manifests.find((x) => x.platform?.os !== "unknown") ?? m.manifests[0];
    if (!pick?.digest || !/^sha256:[0-9a-f]{64}$/.test(pick.digest)) throw new RegistryError("failed", "no platform manifest");
    m = (await json(`https://${r.host}/v2/${r.repo}/manifests/${pick.digest}`, { ...auth, accept: MANIFEST_TYPES })) as Manifest;
  }
  const digest = m.config?.digest ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new RegistryError("failed", "no config digest");
  return factsOfImageConfig(await json(`https://${r.host}/v2/${r.repo}/blobs/${digest}`, auth));
}

// A digest never changes: its facts are kept a day; a tag 30 minutes; a refusal per registry 10 minutes
const factsCache = new CacheManager<ImageConfigFacts>(600, 24 * 60 * 60_000);
const denied = new CacheManager<ImageConfigState>(50, 10 * 60_000);
const MAX_IMAGES = 80, BUDGET_MS = 10_000, PARALLEL = 4;

/** `byImage` is keyed by the caller's `key` */
export type ImageConfigResult = { state: ImageConfigState; byImage: Map<string, ImageConfigFacts>; read: number; pending: number };

/**
 * Config facts for the cluster's ACR images with the cluster connection's identity. Never throws: the state says why
 * nothing was read (off = the connection did not opt in · none = no ACR image). Unfinished images within the time
 * budget are `pending` (read on the next refresh — the cache keeps what was read).
 */
export async function collectImageConfigs(
  env: Env, bearerToken: string | undefined, clusterId: string, images: Array<{ key: string; image: string; imageId?: string }>, doFetch: Fetch = fetch,
): Promise<ImageConfigResult> {
  const byImage = new Map<string, ImageConfigFacts>();
  const empty = (state: ImageConfigState): ImageConfigResult => ({ state, byImage, read: 0, pending: 0 });
  if (!bearerToken) return empty("off");
  let conn: ReturnType<typeof clusterConnection>;
  try { conn = clusterConnection(env, clusterId); } catch { return empty("off"); }
  if (!conn.connection.aks?.imageConfig) return empty("off");
  const refs = new Map<string, { keys: string[]; host: string; repo: string; ref: string }>();
  for (const i of images) {
    const r = acrRef(i.image, i.imageId);
    if (!r) continue;
    const k = `${r.host}/${r.repo}@${r.ref}`;
    const have = refs.get(k);
    if (have) have.keys.push(i.key);
    else if (refs.size < MAX_IMAGES) refs.set(k, { keys: [i.key], ...r });
  }
  if (!refs.size) return empty("none");
  const todo: Array<[string, { keys: string[]; host: string; repo: string; ref: string }]> = [];
  for (const [key, r] of refs) {
    const hit = factsCache.get(key);
    if (hit) r.keys.forEach((x) => byImage.set(x, hit)); else todo.push([key, r]);
  }
  let state: ImageConfigState = "ok";
  const deadline = Date.now() + BUDGET_MS;
  const tokens = new Map<string, Promise<string>>();
  let aad: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const [key, r] = todo[next++]!;
      const refused = denied.get(r.host);
      if (refused) { state = refused; continue; }
      try {
        aad ??= await connectionToken(env, bearerToken, conn.connection, "https://management.azure.com/.default");
        const tk = `${r.host}/${r.repo}`;
        if (!tokens.has(tk)) tokens.set(tk, repoToken(doFetch, r.host, r.repo, aad, conn.tokenTenantId));
        const facts = await readImageConfig(doFetch, r, await tokens.get(tk)!);
        factsCache.set(key, facts, r.ref.startsWith("sha256:") ? undefined : 30 * 60_000);
        r.keys.forEach((x) => byImage.set(x, facts));
      } catch (e) {
        const s: ImageConfigState = e instanceof RegistryError ? e.state : "failed";
        if (s === "none") continue;                        // that image is gone from the registry — the others go on
        state = s;
        if (s === "forbidden" || s === "unreachable") denied.set(r.host, s);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const read = [...refs.values()].filter((r) => byImage.has(r.keys[0]!)).length;
  return { state: read ? "ok" : state, byImage, read, pending: refs.size - read };
}
