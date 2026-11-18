// 알림 센터 › 보내는 곳 › 연결 확인 — can the API reach a channel's host? Name → TCP → TLS handshake, then it hangs up:
// no HTTP request is made, so nothing reaches the chat room (the test send is the step that posts). It separates the
// network question (firewall · NAT · DNS · certificate) from the receiver's answer (address · template).
// Why: on stg (2026-11-18) the Flow test room got nothing for days and the only signal was "주소 변수 없음" — and when
// the URL is set, a "연결 안 됨" from a test send lumped a wrong name, a closed firewall and a refused certificate together.
import { lookup } from "node:dns/promises";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import type { NotifyChannelCheck, NotifyFailCause } from "@aud/types";
import { connectCauseOf } from "../infra/connectCause.js";

/** TLS / certificate error codes (Node · OpenSSL) — the certificate or the handshake was refused */
const TLS_CODES = /^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ERR_TLS_|ERR_SSL_|EPROTO$|HOSTNAME_MISMATCH|ERR_OSSL)/;

function codesOf(e: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = e;
  for (let d = 0; cur && typeof cur === "object" && d < 4; d++) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === "string") out.push(c.code);
    cur = c.cause;
  }
  return out;
}

/** Pure: a failed send / check → why (socket cause first, then a refused certificate), null = the codes say nothing */
export function failCauseOf(e: unknown): NotifyFailCause | null {
  const socket = connectCauseOf(e);
  if (socket) return socket;
  return codesOf(e).some((c) => TLS_CODES.test(c)) ? "tls" : null;
}

/** Pure: the TLS error code to show (CERT_HAS_EXPIRED …) */
export const tlsCodeOf = (e: unknown): string | undefined => codesOf(e).find((c) => TLS_CODES.test(c));

/** Pure: RFC 1918 · CGNAT · loopback · link-local · IPv6 ULA / loopback — "the host is on an internal network" */
export function isPrivateAddress(a: string): boolean {
  if (isIP(a) === 4) {
    const [x = 0, y = 0] = a.split(".").map(Number);
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
  }
  const l = a.toLowerCase();
  return l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

/**
 * Pure: does Node send to this host through an HTTP proxy? (NODE_USE_ENV_PROXY=1 + HTTPS_PROXY / HTTP_PROXY, unless
 * NO_PROXY matches — "*", a host, ".suffix" or "suffix"). Then a direct check tests the wrong path.
 */
export function viaProxy(url: URL, vars: Record<string, string | undefined>): boolean {
  if (!/^(1|true)$/i.test(vars.NODE_USE_ENV_PROXY ?? "")) return false;
  const proxy = url.protocol === "https:" ? (vars.HTTPS_PROXY ?? vars.https_proxy) : (vars.HTTP_PROXY ?? vars.http_proxy);
  if (!proxy) return false;
  const host = url.hostname.toLowerCase();
  const rules = (vars.NO_PROXY ?? vars.no_proxy ?? "").split(",").map((s) => s.trim().toLowerCase().replace(/:\d+$/, "")).filter(Boolean);
  return !rules.some((r) => r === "*" || host === r.replace(/^\./, "") || host.endsWith(r.startsWith(".") ? r : `.${r}`));
}

/** Pure: the certificate facts shown on the screen */
export function certFacts(c: Pick<PeerCertificate, "issuer" | "valid_to"> | undefined, now = Date.now()): NotifyChannelCheck["cert"] | undefined {
  if (!c?.valid_to) return undefined;
  const to = new Date(c.valid_to);
  if (!Number.isFinite(to.getTime())) return undefined;
  const issuer = c.issuer ? (c.issuer.O ?? c.issuer.CN ?? null) : null;
  return { issuer: Array.isArray(issuer) ? issuer[0] ?? null : issuer, validTo: to.toISOString(), daysLeft: Math.floor((to.getTime() - now) / 86_400_000) };
}

type Deps = {
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the connection; resolves with the peer certificate (TLS) or undefined (plain TCP) */
  open?: (url: URL, timeoutMs: number) => Promise<Pick<PeerCertificate, "issuer" | "valid_to"> | undefined>;
  vars?: Record<string, string | undefined>;
  now?: () => number;
};

const portOf = (u: URL) => Number(u.port || (u.protocol === "https:" ? 443 : 80));

/** Connect, finish the TLS handshake (certificate checked as a send would), hang up — never writes a byte of HTTP */
function openReal(url: URL, timeoutMs: number): Promise<Pick<PeerCertificate, "issuer" | "valid_to"> | undefined> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const tls = url.protocol === "https:";
    const sock = tls
      ? tlsConnect({ host, port: portOf(url), servername: isIP(host) ? undefined : host, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] })
      : netConnect({ host, port: portOf(url) });
    const timer = setTimeout(() => sock.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    sock.once("error", (e) => { clearTimeout(timer); reject(e); });
    sock.once(tls ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      const cert = tls ? (sock as ReturnType<typeof tlsConnect>).getPeerCertificate() : undefined;
      sock.end();
      sock.destroy();
      resolve(cert && Object.keys(cert).length ? cert : undefined);
    });
  });
}

export async function checkChannel(url: URL, timeoutMs = 5000, deps: Deps = {}): Promise<NotifyChannelCheck> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const out = (r: Omit<NotifyChannelCheck, "ms">): NotifyChannelCheck => ({ ...r, ms: now() - t0 });
  if (viaProxy(url, deps.vars ?? (process.env as Record<string, string | undefined>))) return out({ ok: false, stage: "none", viaProxy: true });

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : await (deps.resolve ?? (async (h) => (await lookup(h, { all: true })).map((x) => x.address)))(host);
  } catch (e) {
    return out({ ok: false, stage: "none", cause: failCauseOf(e) ?? "dns" });
  }
  const resolved = { addresses: addrs.length, privateAddress: addrs.some(isPrivateAddress) };
  try {
    const cert = await (deps.open ?? openReal)(url, timeoutMs);
    return out({ ok: true, stage: url.protocol === "https:" ? "tls" : "connect", ...resolved, ...(cert ? { cert: certFacts(cert, now()) } : {}) });
  } catch (e) {
    const cause = failCauseOf(e);
    // A refused certificate means TCP was open; anything else stopped before or at the TCP connect
    if (cause === "tls") return out({ ok: false, stage: "connect", cause, ...(tlsCodeOf(e) ? { tlsCode: tlsCodeOf(e) } : {}), ...resolved });
    return out({ ok: false, stage: "dns", ...(cause ? { cause } : {}), ...resolved });
  }
}
