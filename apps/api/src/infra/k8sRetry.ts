// One retry for an idempotent Kubernetes read that hit a transient failure (pure decision + tiny wrapper). Without
// it a blip — konnectivity, the private endpoint's LB, an API server 429/5xx — turns a list into an empty one and the
// policy pages silently lose issues ("클러스터 데이터 일부 누락"). Only list/get calls: never exec or log streams.
//
// Connections are not reused (no keep-alive agent): @kubernetes/client-node 1.x reads through node-fetch 2, whose
// fixResponseChunkedTransferBadEnding raises a false "Premature close" for chunked (gzip) responses on a socket that
// stays alive — a pooled keep-alive agent made 5 of ~20 concurrent lists fail in a customer cluster (2026-10-23).

const RETRY_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE", "UND_ERR_SOCKET"]);

/** HTTP status of a client-node error (`code` is the status on ApiException) */
export function k8sStatusOf(e: unknown): number | undefined {
  if (e && typeof e === "object") {
    const o = e as { code?: unknown; statusCode?: unknown };
    if (typeof o.code === "number") return o.code;
    if (typeof o.statusCode === "number") return o.statusCode;
  }
  return undefined;
}

export function retryableK8sError(e: unknown): boolean {
  const status = k8sStatusOf(e);
  if (status !== undefined) return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  const err = (e ?? {}) as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  const code = typeof err.code === "string" ? err.code : typeof err.cause?.code === "string" ? err.cause.code : "";
  return RETRY_CODES.has(code) || /Premature close|socket hang up|other side closed/i.test(String(err.message ?? ""));
}

/** Run once; on a retryable failure wait briefly and run exactly once more (the second failure is thrown) */
export async function withK8sRetry<T>(fn: () => Promise<T>, delayMs = 250 + Math.floor(Math.random() * 250)): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!retryableK8sError(e)) throw e;
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

/** Why a read failed, for the gap line the user sees */
export function k8sFailureReason(e: unknown): string {
  const status = k8sStatusOf(e);
  return status !== undefined ? `HTTP ${status}` : retryableK8sError(e) ? "network" : "error";
}
