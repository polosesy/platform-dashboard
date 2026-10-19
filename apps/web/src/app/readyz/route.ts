// Readiness of the pod: the web answers AND the API next to it (127.0.0.1:4000, the same address the /api rewrite
// uses) answers its /healthz within 2 s. Never touches Azure — a slow or unreachable Azure must not take the pod
// out of service.
export const dynamic = "force-dynamic";

const API = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

export async function GET() {
  const headers = { "cache-control": "no-store" };
  try {
    const r = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    if (!r.ok) return Response.json({ ok: false, api: r.status }, { status: 503, headers });
    return Response.json({ ok: true }, { headers });
  } catch {
    return Response.json({ ok: false, api: "unreachable" }, { status: 503, headers });
  }
}
