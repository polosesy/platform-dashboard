"use client";

import { useEffect, useState } from "react";
import styles from "./styles.module.css";
import type { ArgoAppsResponse } from "@/lib/types";
import { apiBaseUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";

async function loadApps(bearerToken: string | null): Promise<ArgoAppsResponse> {
  const url = `${apiBaseUrl()}/api/argocd/apps`;
  return fetchJsonWithBearer<ArgoAppsResponse>(url, bearerToken);
}

export default function ArgoCDPage() {
  const [data, setData] = useState<ArgoAppsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const getApiToken = useApiToken();

  useEffect(() => {
    let cancelled = false;
    getApiToken()
      .then((token) => loadApps(token))
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      });
    return () => {
      cancelled = true;
    };
  }, [getApiToken]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>ArgoCD</div>
          <div className={styles.subTitle}>{data ? `Generated: ${new Date(data.generatedAt).toLocaleString()}` : "Loading..."}</div>
        </div>
        <div className={styles.meta}>
          <span className={styles.metaKey}>API</span>
          <span className={styles.metaValue}>{apiBaseUrl()}</span>
        </div>
      </div>

      {error ? <div className={styles.error}>Failed to load: {error}</div> : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>App</th>
              <th>Health</th>
              <th>Sync</th>
              <th>Revision</th>
              <th>Last deployed</th>
            </tr>
          </thead>
          <tbody>
            {(data?.apps ?? []).map((a) => (
              <tr key={a.name}>
                <td>
                  <div className={styles.appName}>{a.name}</div>
                  <div className={styles.appMeta}>{[a.project, a.namespace].filter(Boolean).join(" / ")}</div>
                </td>
                <td>{a.health ?? "-"}</td>
                <td>{a.sync ?? "-"}</td>
                <td className={styles.mono}>{a.revision ?? "-"}</td>
                <td className={styles.mono}>{a.lastDeployedAt ? new Date(a.lastDeployedAt).toLocaleString() : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data ? <div className={styles.tableHint}>Loading...</div> : null}
      </div>
    </div>
  );
}
