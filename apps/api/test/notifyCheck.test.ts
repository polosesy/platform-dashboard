// 알림 센터 › 보내는 곳 — '연결 확인' (name → TCP → TLS, nothing sent), the cause of a failed send, the channels
// without a URL (said at startup), and the Helm values that put the URLs in from a Secret.
// Real sockets on 127.0.0.1 where the behaviour matters (no byte of HTTP, refused, a broken TLS handshake).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { certFacts, checkChannel, failCauseOf, isPrivateAddress, tlsCodeOf, viaProxy } from "../src/services/notifyCheck.js";
import { sendToChannel } from "../src/services/notifyRelay.js";
import { channelInfo, loadChannels, type Channel } from "../src/services/notifyChannels.js";
import { unconfiguredChannels } from "../src/routes/notify.js";
import { parseAlertPayload, samplePayload } from "../src/services/alertPayloads.js";
import { applyDelivery } from "../src/services/notifyStore.js";
import * as viewMod from "../../web/src/lib/notifyView.ts";
const V = ((viewMod as { default?: typeof viewMod }).default ?? viewMod) as typeof viewMod;

const ROOT = resolve(import.meta.dirname, "../../..");
const err = (code: string, wrapped = true) => wrapped ? Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }) : Object.assign(new Error(code), { code });

const channel = (over: Partial<Channel> = {}): Channel => loadChannels({ AUD_NOTIFY_CHANNELS: JSON.stringify([{ key: "flow-test", name: "Flow 시험방", format: "flow", urlEnv: "AUD_NOTIFY_URL_FLOW_TEST", ...over }]) })[0]!;

/** A TCP server that records every byte it receives; `reply` is written (and the socket ended) after the first bytes */
async function listen(reply?: Buffer): Promise<{ server: Server; port: number; received: () => Buffer }> {
  const chunks: Buffer[] = [];
  const server = createServer((s) => {
    s.on("data", (d) => { chunks.push(d); if (reply && chunks.length === 1) s.end(reply); });
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, received: () => Buffer.concat(chunks) };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test("failCauseOf: socket causes first (through fetch's wrapper), then a refused certificate", () => {
  assert.equal(failCauseOf(err("ENOTFOUND")), "dns");
  assert.equal(failCauseOf(err("ECONNREFUSED")), "refused");
  assert.equal(failCauseOf(err("UND_ERR_CONNECT_TIMEOUT")), "timeout");
  assert.equal(failCauseOf(err("EHOSTUNREACH")), "noRoute");
  for (const c of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]) {
    assert.equal(failCauseOf(err(c)), "tls", c);
  }
  assert.equal(tlsCodeOf(err("CERT_HAS_EXPIRED")), "CERT_HAS_EXPIRED");
  assert.equal(failCauseOf(new Error("something else")), null, "no code → no claim");
});

test("viaProxy: only when Node uses the proxy variables and NO_PROXY does not match the host", () => {
  const u = new URL("https://flow.example.com/flowlabs/api/v1/webhook/x");
  assert.equal(viaProxy(u, { HTTPS_PROXY: "http://proxy:3128" }), false, "without NODE_USE_ENV_PROXY Node's fetch ignores it");
  assert.equal(viaProxy(u, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128" }), true);
  assert.equal(viaProxy(u, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: ".example.com" }), false);
  assert.equal(viaProxy(u, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost,example.com" }), false, "a bare suffix covers subdomains (curl / Node)");
  assert.equal(viaProxy(u, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "other.com" }), true);
  assert.equal(viaProxy(u, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "*" }), false);
});

test("isPrivateAddress and certFacts", () => {
  for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.6.1", "100.64.0.1", "127.0.0.1", "fd00::1", "::1"]) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ["172.32.0.1", "8.8.8.8", "203.0.113.10", "2001:db8::1"]) assert.equal(isPrivateAddress(a), false, a);
  const now = Date.parse("2026-11-18T00:00:00Z");
  assert.deepEqual(certFacts({ issuer: { O: "Let's Encrypt", CN: "YE1" } as never, valid_to: "Jan  9 02:20:22 2027 GMT" }, now), { issuer: "Let's Encrypt", validTo: "2027-01-09T02:20:22.000Z", daysLeft: 52 });
  assert.equal(certFacts(undefined), undefined);
});

test("check of an https channel: a TLS handshake only — the receiver never sees a byte of HTTP (nothing reaches the room)", async () => {
  // A server that is not TLS: the client's ClientHello arrives, the garbage answer breaks the handshake → tls
  const srv = await listen(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"));
  try {
    const r = await checkChannel(new URL(`https://127.0.0.1:${srv.port}/flowlabs/api/v1/webhook/token`), 3000);
    assert.equal(r.ok, false);
    assert.equal(r.cause, "tls");
    assert.equal(r.stage, "connect", "TCP was open — the certificate / handshake failed");
    assert.equal(r.privateAddress, true);
    const got = srv.received();
    assert.equal(got[0], 0x16, "a TLS handshake record (ClientHello)");
    assert.doesNotMatch(got.toString("latin1"), /POST|GET |HTTP\/1|webhook|token/, "no request line, no path, no token");
  } finally { await close(srv.server); }
});

test("check of an http channel (allowHttp): TCP open and closed — zero bytes written", async () => {
  const srv = await listen();
  try {
    const r = await checkChannel(new URL(`http://127.0.0.1:${srv.port}/hook`), 3000);
    assert.equal(r.ok, true);
    assert.equal(r.stage, "connect");
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(srv.received().length, 0);
  } finally { await close(srv.server); }
});

test("check: refused port · unresolved name · timeout · success with the certificate (injected)", async () => {
  const srv = await listen();
  const port = srv.port;
  await close(srv.server); // nothing listens there now
  const refused = await checkChannel(new URL(`https://127.0.0.1:${port}/x`), 3000);
  assert.deepEqual([refused.ok, refused.cause, refused.stage], [false, "refused", "dns"]);

  const dns = await checkChannel(new URL("https://flow.invalid/x"), 3000, { resolve: async () => { throw err("ENOTFOUND", false); } });
  assert.deepEqual([dns.ok, dns.cause, dns.stage, dns.addresses], [false, "dns", "none", undefined]);

  const slow = await checkChannel(new URL("https://flow.example.com/x"), 3000, { resolve: async () => ["203.0.113.10"], open: async () => { throw err("ETIMEDOUT", false); } });
  assert.deepEqual([slow.cause, slow.addresses, slow.privateAddress], ["timeout", 1, false]);

  const now = Date.parse("2026-11-18T00:00:00Z");
  const ok = await checkChannel(new URL("https://flow.example.com/x"), 3000, {
    resolve: async () => ["203.0.113.10"], now: () => now,
    open: async () => ({ issuer: { O: "Let's Encrypt" } as never, valid_to: "Nov 25 00:00:00 2026 GMT" }),
  });
  assert.deepEqual([ok.ok, ok.stage, ok.cert?.daysLeft], [true, "tls", 7]);
  const line = V.checkLine(ok);
  assert.equal(line.tone, "warn", "a certificate under 14 days left is worth saying");
  assert.ok(line.parts.some((p) => p.key === "notify.chk.certSoon"));
  assert.ok(line.parts.some((p) => p.key === "notify.chk.nothingSent"));

  const proxied = await checkChannel(new URL("https://flow.example.com/x"), 3000, { vars: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://p:3128" } });
  assert.equal(proxied.viaProxy, true);
  assert.deepEqual(V.checkLine(proxied).parts.map((p) => p.key), ["notify.chk.proxy"]);
  assert.equal(V.checkLine(refused).tone, "fail");
  assert.equal(V.checkLine(refused).parts[0]!.key, "notify.chk.fail.refused");
});

test("a failed send records why: the delivery carries the cause (refused, certificate …)", async () => {
  const r = parseAlertPayload(samplePayload("grafana"), new Date("2026-11-18T00:00:00Z"));
  assert.ok(r.kind !== "unsupported");
  const { next } = applyDelivery({}, [r.alerts[0]!], new Date("2026-11-18T00:00:00Z"), () => "platform");
  const a = Object.values(next)[0]!;
  const c = channel();
  const vars = { AUD_NOTIFY_URL_FLOW_TEST: "https://flow.example.com/flowlabs/api/v1/webhook/x" };
  const refused = await sendToChannel(c, a, null, vars, { retryMs: 0, fetchImpl: (async () => { throw err("ECONNREFUSED"); }) as typeof fetch });
  assert.deepEqual([refused.ok, refused.error, refused.cause, refused.attempts], [false, "network", "refused", 2]);
  const cert = await sendToChannel(c, a, null, vars, { retryMs: 0, fetchImpl: (async () => { throw err("CERT_HAS_EXPIRED"); }) as typeof fetch });
  assert.equal(cert.cause, "tls");
  const http = await sendToChannel(c, a, null, vars, { retryMs: 0, fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch });
  assert.deepEqual([http.error, http.cause, http.status], ["http", undefined, 404], "an answer is not a connection problem");
});

test("channels without a URL are named at startup, and the screen gets the variable's name (never a value)", () => {
  const c = channel();
  assert.deepEqual(unconfiguredChannels([c], {}).map((x) => x.key), ["flow-test"]);
  assert.deepEqual(unconfiguredChannels([c], { AUD_NOTIFY_URL_FLOW_TEST: "http://flow.example.com/x" }).map((x) => x.key), ["flow-test"], "http without allowHttp is not usable");
  assert.deepEqual(unconfiguredChannels([c], { AUD_NOTIFY_URL_FLOW_TEST: "https://flow.example.com/flowlabs/api/v1/webhook/secret" }), []);
  assert.deepEqual(unconfiguredChannels([channel({ enabled: false })], {}), [], "a disabled channel is not a gap");
  const info = channelInfo(c, { AUD_NOTIFY_URL_FLOW_TEST: "https://flow.example.com/flowlabs/api/v1/webhook/secret" });
  assert.equal(info.urlEnv, "AUD_NOTIFY_URL_FLOW_TEST");
  assert.equal(info.host, "flow.example.com");
  assert.doesNotMatch(JSON.stringify(info), /secret|webhook/, "the path (the receiver's token) never leaves the API");
});

test("Helm notify values: channels → AUD_NOTIFY_CHANNELS, each URL / auth variable from the Secret (optional), only AUD_NOTIFY_* names", (t) => {
  const helm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
  if (helm.status !== 0) return t.skip("helm not installed");
  const tpl = (...set: string[]) => spawnSync("helm", ["template", "aud-dashboard", "deploy/helm/aud-dashboard", "--namespace", "aud-dashboard", ...set.flatMap((s) => ["--set", s])], { cwd: ROOT, encoding: "utf8" });
  const off = tpl();
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /AUD_NOTIFY_CHANNELS/, "no channels by default");
  const on = tpl("notify.urlSecret=aud-notify-urls", "notify.channels[0].key=flow-test", "notify.channels[0].name=Flow", "notify.channels[0].format=flow",
    "notify.channels[0].urlEnv=AUD_NOTIFY_URL_FLOW_TEST", "notify.channels[1].key=relay", "notify.channels[1].name=relay", "notify.channels[1].format=json",
    "notify.channels[1].urlEnv=AUD_NOTIFY_URL_RELAY", "notify.channels[1].authHeaderEnv=AUD_NOTIFY_AUTH_RELAY");
  assert.equal(on.status, 0, on.stderr);
  const json = /name: AUD_NOTIFY_CHANNELS, value: ("(?:[^"\\]|\\.)*")/.exec(on.stdout);
  assert.ok(json, "the channel list is set");
  const channels = loadChannels({ AUD_NOTIFY_CHANNELS: JSON.parse(json[1]!) as string });
  assert.deepEqual(channels.map((c) => c.key), ["flow-test", "relay"], "the API reads what the chart wrote");
  for (const name of ["AUD_NOTIFY_URL_FLOW_TEST", "AUD_NOTIFY_URL_RELAY", "AUD_NOTIFY_AUTH_RELAY"]) {
    assert.match(on.stdout, new RegExp(`- name: ${name}\\n\\s+valueFrom: \\{ secretKeyRef: \\{ name: "aud-notify-urls", key: ${name}, optional: true \\} \\}`), name);
  }
  assert.notEqual(tpl("notify.channels[0].key=x", "notify.channels[0].urlEnv=AUD_NOTIFY_URL_X").status, 0, "channels without the Secret's name fail the render");
  const bad = tpl("notify.urlSecret=s", "notify.channels[0].key=x", "notify.channels[0].urlEnv=AZURE_CLIENT_ID");
  assert.notEqual(bad.status, 0, "a channel cannot pull another variable from the Secret");
  assert.match(bad.stderr, /urlEnv must match/);
});
