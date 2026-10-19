"use client";

import { createContext, useContext } from "react";
import type { WebRuntimeConfig } from "./runtimeConfig";

/** The sign-in settings the server read for this page (lib/runtimeConfig.ts) */
const WebConfigContext = createContext<WebRuntimeConfig>({ tenantId: "", clientId: "", apiScope: "" });

export const WebConfigProvider = WebConfigContext.Provider;
export const useWebConfig = () => useContext(WebConfigContext);
