// Liveness of the web container: answers while the Next.js server runs (no API, no Azure). Probes and compose health.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, version: process.env.AUD_VERSION || "dev" }, { headers: { "cache-control": "no-store" } });
}
