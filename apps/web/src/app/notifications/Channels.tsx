"use client";

// 알림 센터 › 연동 설정 › 보내는 곳: the outbound chat channels (Flow · Slack · Google Chat · Teams · Azure / Grafana
// shapes). Admin only — the webhook URL is never shown, only its host. Per channel: the body it would get for a sample
// alert (preview) and a real test send with the receiver's answer (status · time · attempts).

import { useState } from "react";
import type { NotifyChannelInfo, NotifyChannelTest } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useApiToken } from "@/lib/useApiToken";
import { Badge, Button, EmptyState, Panel, Segmented } from "@/components/ui";
import { channelsSnippet, flowTemplateHint } from "@/lib/notifyView";
import s from "./notifications.module.css";

export function Channels({ channels }: { channels: NotifyChannelInfo[] }) {
  const { t } = useI18n();
  const getToken = useApiToken();
  const [kind, setKind] = useState<"grafana" | "azure">("grafana");
  const [preview, setPreview] = useState<{ key: string; body: string } | null>(null);
  const [results, setResults] = useState<Record<string, NotifyChannelTest | string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const call = async <T,>(path: string, method: "GET" | "POST"): Promise<T> => {
    const token = await getToken().catch(() => null);
    return fetchJsonWithBearer<T>(apiUrl(path, { kind }), token, { method });
  };
  const doPreview = async (key: string) => {
    if (preview?.key === key) { setPreview(null); return; }
    try {
      const r = await call<{ body: unknown }>(`/api/notifications/channels/${encodeURIComponent(key)}/preview`, "GET");
      setPreview({ key, body: JSON.stringify(r.body, null, 2) });
    } catch (e) { setResults({ ...results, [key]: e instanceof ApiError && e.code ? e.code : String(e) }); }
  };
  const doTest = async (key: string) => {
    setBusy(key);
    try {
      setResults({ ...results, [key]: await call<NotifyChannelTest>(`/api/notifications/channels/${encodeURIComponent(key)}/test`, "POST") });
    } catch (e) { setResults({ ...results, [key]: e instanceof ApiError && e.code ? e.code : String(e) }); }
    setBusy(null);
  };
  const resultText = (r: NotifyChannelTest | string | undefined) => {
    if (!r) return null;
    if (typeof r === "string") return <span className={s.err}>{r}</span>;
    return r.ok
      ? <span className={s.ack}>{t("notify.ch.sent", { status: r.status ?? "", ms: r.ms })}</span>
      : <span className={s.err}>{t(`notify.ch.fail.${r.error ?? "http"}`, { status: r.status ?? "—", n: r.attempts })}</span>;
  };

  return (
    <Panel title={t("notify.ch.title")} sub={t("notify.ch.sub")}
      actions={<Segmented label={t("notify.ch.sample")} value={kind} onChange={setKind} items={[{ id: "grafana" as const, label: t("notify.ch.sampleGrafana") }, { id: "azure" as const, label: t("notify.ch.sampleAzure") }]} />}>
      {channels.length ? (
        <ul className={s.chList}>
          {channels.map((c) => (
            <li key={c.key} className={s.chItem}>
              <div className={s.chHead}>
                <b>{c.name}</b>
                <Badge tone="info">{t(`notify.ch.format.${c.format}`)}</Badge>
                {c.configured ? <span className={s.mono}>{c.host}</span> : <Badge tone="medium">{t("notify.ch.noUrl")}</Badge>}
                {!c.enabled ? <Badge tone="neutral">{t("notify.ch.disabled")}</Badge> : null}
              </div>
              <div className={s.muted}>
                {t("notify.ch.rules", {
                  sev: t(`notify.sev.${c.minSeverity}`),
                  cats: c.categories.length ? c.categories.map((x) => t(`notify.cat.${x}`)).join("·") : t("notify.all"),
                  teams: c.teams.length ? c.teams.join("·") : t("notify.all"),
                  states: c.statuses.map((x) => t(`notify.status.${x}`)).join("·"),
                })}{c.prefix ? ` · ${t("notify.ch.prefix")} "${c.prefix}"` : ""} · {c.lang}
              </div>
              <div className={s.ackRow}>
                <Button size="sm" onClick={() => void doPreview(c.key)}>{preview?.key === c.key ? t("notify.ch.hide") : t("notify.ch.preview")}</Button>
                <Button size="sm" variant="primary" onClick={() => void doTest(c.key)} disabled={!c.configured || busy === c.key}>{busy === c.key ? t("notify.ch.sending") : t("notify.ch.test")}</Button>
                {resultText(results[c.key])}
              </div>
              {preview?.key === c.key ? <pre className={s.code}>{preview.body}</pre> : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("notify.ch.none")}>{t("notify.ch.noneHint")}</EmptyState>
      )}
      <details className={s.howTo}>
        <summary>{t("notify.ch.howTo")}</summary>
        <pre className={s.code}>{channelsSnippet()}</pre>
        <p className={s.muted}>{t("notify.ch.flowHint")}</p>
        <pre className={s.code}>{flowTemplateHint()}</pre>
      </details>
    </Panel>
  );
}
