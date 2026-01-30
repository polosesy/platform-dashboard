import type { Configuration, PopupRequest } from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID ?? "";
const clientId = process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID ?? "";
const redirectUri = process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI ?? "http://localhost:3000";

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: tenantId ? `https://login.microsoftonline.com/${tenantId}` : "https://login.microsoftonline.com/common",
    redirectUri
  },
  cache: {
    cacheLocation: "sessionStorage"
  }
};

export const loginRequest: PopupRequest = {
  scopes: ["openid", "profile", "email"]
};
