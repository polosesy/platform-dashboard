// The web's sign-in settings are read per request (one image, any host): runtime AUD_WEB_* first, the build-time
// NEXT_PUBLIC_AZURE_AD_* as the development fallback; only https or http://localhost redirects.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as cfgNs from "../../web/src/lib/runtimeConfig.ts";

const C = ((cfgNs as unknown as { default?: typeof cfgNs }).default ?? cfgNs) as typeof cfgNs;

test("runtime settings win over build-time ones; an empty runtime value falls back", () => {
  const cfg = C.webRuntimeConfig({
    AUD_WEB_TENANT_ID: "t-runtime", AUD_WEB_CLIENT_ID: "c-runtime", AUD_WEB_REDIRECT_URI: "https://aud.example.internal/",
    AUD_WEB_API_SCOPE: " api://aud/Azure.Read.All ",
    NEXT_PUBLIC_AZURE_AD_TENANT_ID: "t-build", NEXT_PUBLIC_AZURE_AD_CLIENT_ID: "c-build",
  });
  assert.deepEqual(cfg, { tenantId: "t-runtime", clientId: "c-runtime", redirectUri: "https://aud.example.internal/", apiScope: "api://aud/Azure.Read.All" });
  assert.equal(C.webRuntimeConfig({ AUD_WEB_CLIENT_ID: "  ", NEXT_PUBLIC_AZURE_AD_CLIENT_ID: "c-build" }).clientId, "c-build");
  assert.ok(C.signInConfigured(cfg));
  assert.ok(!C.signInConfigured(C.webRuntimeConfig({})));
});

test("redirects: https anywhere, http only for localhost; anything else is dropped (the page origin is used)", () => {
  assert.ok(C.validRedirect("https://aud.example.internal/"));
  assert.ok(C.validRedirect("http://localhost:3000"));
  assert.ok(!C.validRedirect("http://onprem-server:3000"), "Entra rejects a plain-http SPA redirect off localhost");
  assert.ok(!C.validRedirect("not a url"));
  assert.equal(C.webRuntimeConfig({ AUD_WEB_REDIRECT_URI: "http://onprem-server:3000" }).redirectUri, undefined);
});
