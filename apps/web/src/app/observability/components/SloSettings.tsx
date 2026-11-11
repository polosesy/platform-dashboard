"use client";

// AKS 모니터링 › SLO › 설정 — the team's SLO targets and error-budget resets on the platform (API
// services/sloSettingsStore.ts). Read by anyone signed in, changed by operators.
//   • 클러스터 기본 목표   window · availability · latency threshold + target · URIs not counted — empty = inherit
//                          (the connection file, else the defaults — each field says what it inherits)
//   • 에러 버짓 초기화     count one service's (or every service's) budget from a time, with a reason; undo; the burn
//                          alerts are not reset (they measure now)
//   • 서비스별 목표        per service, over the cluster's (the most specific wins — lib/sloSettingsView `inherited`)
//   • 변경 기록            who · when · what (no values)
// A save names the settings revision it edited — another save first = 409: the newer settings load, the user decides again.

import { useMemo, useState } from "react";
import type { SloBudgetReset, SloSettingsResponse, WorkloadSloResponse } from "@aud/types";
import { ApiError, apiUrl, fetchJsonWithBearer } from "@/lib/api";
import { useApiToken } from "@/lib/useApiToken";
import { dateLocale, useI18n } from "@/lib/i18n";
import {
  Button, Cell, Chip, Grid, LinkButton, Notice, Panel, SearchInput, Select, TextInput, Toggle, Toolbar,
} from "@/components/ui";
import {
  EMPTY_SERVICE, TARGET_TIERS, WINDOW_DAYS, draftOf, inherited, inheritedWindow, localToIso, resetState, sameSettings, serviceRows, settingsOf,
  spanLabel, type ServiceDraft, type SettingsDraft,
} from "@/lib/sloSettingsView";
import { msText, targetText } from "@/lib/sloView";
import styles from "../styles.module.css";

type Write = (method: "PUT" | "POST" | "DELETE", path: string, params: Record<string, string>, body?: unknown) => Promise<SloSettingsResponse>;

/** POST / PUT / DELETE an SLO settings path with the signed-in user's token */
export function useSloWrite(clusterId: string): Write {
  const getToken = useApiToken();
  return async (method, path, params, body) => {
    const token = await getToken().catch(() => null);
    return fetchJsonWithBearer<SloSettingsResponse>(apiUrl(path, { clusterId, ...params }), token,
      { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  };
}

/** The API's refusals that have a sentence; anything else reads as "could not save (code)" */
const ERR_CODES = new Set([
  "slo_reset_invalid", "slo_reset_time", "slo_reset_full", "slo_reset_not_found", "slo_reset_failed", "slo_settings_invalid",
  "slo_settings_write_failed", "role_required", "signin_required",
]);
const errText = (t: (k: string, v?: Record<string, string | number>) => string, e: unknown, fallback: string) => {
  const code = e instanceof ApiError && e.code ? e.code : fallback;
  return ERR_CODES.has(code) ? t(`ob.slo.set.err.${code}`) : t("ob.slo.set.err.other", { code });
};

/** Reset one service's (or, with `services`, a picked one's or every service's) error budget from now or a time */
export function ResetForm({ clusterId, service, services, onDone, onCancel }: {
  clusterId: string;
  /** a fixed service ("<ns>/<app>") — else pick from `services` (or every service) */
  service?: string;
  services?: string[];
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const write = useSloWrite(clusterId);
  const [target, setTarget] = useState(service ?? "*");
  const [when, setWhen] = useState<"now" | "custom">("now");
  const [at, setAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const iso = when === "custom" ? localToIso(at) : null;
  const ready = reason.trim().length >= 3 && (when === "now" || iso !== null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await write("POST", "/api/observability/slo/resets", {}, { service: target, reason: reason.trim(), ...(iso ? { at: iso } : {}) });
      setReason("");
      onDone();
    } catch (e) {
      setErr(errText(t, e, "slo_reset_failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.sloResetForm}>
      {service ? null : (
        <Select label={t("ob.slo.set.reset.service")} value={target} onChange={setTarget}
          options={[{ value: "*", label: t("ob.slo.set.allServices") }, ...(services ?? []).map((k) => ({ value: k, label: k }))]} />
      )}
      <Select label={t("ob.slo.set.reset.from")} value={when} onChange={(v) => setWhen(v as "now" | "custom")}
        options={[{ value: "now", label: t("ob.slo.set.reset.now") }, { value: "custom", label: t("ob.slo.set.reset.custom") }]} />
      {when === "custom" ? <TextInput label={t("ob.slo.set.reset.at")} type="datetime-local" value={at} onChange={setAt} /> : null}
      <TextInput label={t("ob.slo.set.reset.reason")} value={reason} onChange={setReason} maxLength={200} placeholder={t("ob.slo.set.reset.reasonPh")} width={320} />
      <div className={styles.sloResetActions}>
        <Button variant="primary" size="sm" disabled={!ready || busy} onClick={() => void submit()}>{t("ob.slo.set.reset.do")}</Button>
        {onCancel ? <Button variant="ghost" size="sm" onClick={onCancel}>{t("ob.slo.set.cancel")}</Button> : null}
        {err ? <span className={styles.sloFormErr} role="alert">{err}</span> : null}
      </div>
    </div>
  );
}

/** The counted bucket boundary for a threshold (the largest at or under it) — null = none */
const countedMs = (buckets: number[], ms: number): number | null => {
  const under = buckets.map((b) => b * 1000).filter((b) => b <= ms * (1 + 1e-9));
  return under.length ? Math.max(...under) : null;
};

export function SloSettingsView({ clusterId, d, r, onChanged, onGuide }: {
  clusterId: string;
  d: WorkloadSloResponse;
  r: SloSettingsResponse;
  /** after a save / reset — reload the settings and the SLO numbers */
  onChanged: () => void;
  onGuide: () => void;
}) {
  const { t, locale } = useI18n();
  const write = useSloWrite(clusterId);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(r.settings));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
  const [filter, setFilter] = useState("");
  const { settings, errors } = useMemo(() => settingsOf(draft, r), [draft, r]);
  const dirty = !sameSettings(settings, r.settings);
  const bad = new Set(errors.map((e) => e.field));
  const ro = !r.canWrite;
  const when = (iso: string | number) => new Date(iso).toLocaleString(dateLocale(locale));
  const srcText = (s: string) => t(`ob.slo.set.src.${s}`);
  const pct = (v: number) => targetText(v);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await write("PUT", "/api/observability/slo/settings", {}, { baseRev: r.rev, settings });
      setMsg({ tone: "success", text: t("ob.slo.set.saved") });
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setMsg({ tone: "warning", text: t("ob.slo.set.conflict") });
        onChanged();
      } else setMsg({ tone: "danger", text: errText(t, e, "slo_settings_write_failed") });
    } finally {
      setBusy(false);
    }
  };
  const undoReset = async (x: SloBudgetReset) => {
    try {
      await write("DELETE", "/api/observability/slo/resets", { id: x.id });
      onChanged();
    } catch (e) {
      setMsg({ tone: "danger", text: errText(t, e, "slo_reset_failed") });
    }
  };

  const top = inherited(r, {});
  const win = inheritedWindow(r);
  const targetOptions = (inh: { v: number; source: string }, current: string) => [
    { value: "", label: t("ob.slo.set.inherit", { v: pct(inh.v), src: srcText(inh.source) }) },
    ...[...TARGET_TIERS].reverse().map((x) => ({ value: String(x), label: pct(x) })),
    ...(current && !TARGET_TIERS.some((x) => String(x) === current) ? [{ value: current, label: pct(Number(current)) }] : []),
  ];
  const setTop = (patch: Partial<SettingsDraft>) => setDraft((x) => ({ ...x, ...patch }));
  const setSvc = (key: string, patch: Partial<ServiceDraft>) =>
    setDraft((x) => ({ ...x, services: { ...x.services, [key]: { ...(x.services[key] ?? EMPTY_SERVICE), ...patch } } }));

  const rows = serviceRows(d.services, r).filter((x) => !filter.trim() || x.key.toLowerCase().includes(filter.trim().toLowerCase()));
  const now = Date.now();
  const resets = [...r.resets].sort((a, b) => (a.at < b.at ? 1 : -1));
  const windowDays = d.windowDays;
  const topThreshold = Number(draft.thresholdMs) || top.latency.v.thresholdMs;
  const topCounted = countedMs(d.buckets, topThreshold);

  const notice = msg
    ? <Notice tone={msg.tone}>{msg.text}</Notice>
    : !r.durable ? <Notice tone="warning" title={t("ob.slo.set.memoryTitle")}>{t("ob.slo.set.memory")}</Notice>
    : ro ? <Notice tone="info">{t("ob.slo.set.readOnly")}</Notice>
    : null;

  return (
    <div className={styles.slo}>
      <Toolbar
        start={<span className={styles.sloSetStatus}>
          {dirty ? t("ob.slo.set.dirty") : r.updatedAt ? t("ob.slo.set.lastSaved", { at: when(r.updatedAt), by: r.updatedBy ?? "—" }) : t("ob.slo.set.never")}
          {errors.length ? <Chip level="danger">{t("ob.slo.set.errors", { n: errors.length })}</Chip> : null}
        </span>}
        end={<>
          <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={() => { setDraft(draftOf(r.settings)); setMsg(null); }}>{t("ob.slo.set.discard")}</Button>
          <Button size="sm" variant="primary" disabled={ro || !dirty || errors.length > 0 || busy} onClick={() => void save()}>{t("ob.slo.set.save")}</Button>
        </>} />
      {notice}

      <Grid>
        <Cell span={6}>
          <Panel title={t("ob.slo.set.clusterTitle")} sub={t("ob.slo.set.clusterSub")}
            footer={<span>{t("ob.slo.set.precedence")} <LinkButton onClick={onGuide}>{t("ob.slo.set.fileGuide")}</LinkButton></span>}>
            <div className={styles.sloForm}>
              <Select label={t("ob.slo.set.window")} value={draft.windowDays} disabled={ro} onChange={(v) => setTop({ windowDays: v })}
                options={[
                  { value: "", label: t("ob.slo.set.inheritDays", { v: win.v, src: srcText(win.source) }) },
                  ...WINDOW_DAYS.map((x) => ({ value: String(x), label: t("ob.slo.set.days", { n: x }) })),
                ]} />
              <Select label={t("ob.slo.set.availability")} value={draft.availability} disabled={ro} onChange={(v) => setTop({ availability: v })}
                options={targetOptions(top.availability, draft.availability)} />
              <TextInput label={t("ob.slo.set.threshold")} type="number" value={draft.thresholdMs} disabled={ro} width={140}
                onChange={(v) => setTop({ thresholdMs: v })} placeholder={String(top.latency.v.thresholdMs)}
                hint={bad.has("cluster.thresholdMs") ? t("ob.slo.set.badThreshold")
                  : topCounted === null ? t("ob.slo.set.noBucket") : t("ob.slo.set.counted", { v: msText(topCounted) })} />
              <Select label={t("ob.slo.set.latencyTarget")} value={draft.latencyTarget} disabled={ro} onChange={(v) => setTop({ latencyTarget: v })}
                options={targetOptions({ v: top.latency.v.target, source: top.latency.source }, draft.latencyTarget)} />
              <TextInput label={t("ob.slo.set.excludeUris")} rows={3} value={draft.excludeUris} disabled={ro} onChange={(v) => setTop({ excludeUris: v })}
                placeholder="/public/{id}/webhooks" hint={bad.has("cluster.excludeUris") ? t("ob.slo.set.badUris") : t("ob.slo.set.excludeHint")} />
            </div>
          </Panel>
        </Cell>

        <Cell span={6}>
          <Panel title={t("ob.slo.set.resetTitle")} sub={t("ob.slo.set.resetSub")} footer={<span>{t("ob.slo.set.resetFoot")}</span>}>
            <p className={styles.sloText}>{t("ob.slo.set.resetWhat", { days: windowDays })}</p>
            {!ro ? (
              <ResetForm clusterId={clusterId} services={serviceRows(d.services, r).map((x) => x.key)} onDone={() => { setMsg({ tone: "success", text: t("ob.slo.set.resetDone") }); onChanged(); }} />
            ) : null}
            {resets.length ? (
              <ul className={styles.sloResetList}>
                {resets.map((x) => {
                  const st = resetState(x, now, windowDays);
                  const span = spanLabel(t, (now - Date.parse(x.at)) / 3_600_000);
                  return (
                    <li key={x.id} data-active={st.active || undefined}>
                      <div className={styles.sloResetHead}>
                        <strong>{x.service === "*" ? t("ob.slo.set.allServices") : x.service}</strong>
                        <Chip level={st.active ? "info" : "neutral"} glyph={false}>
                          {st.future ? t("ob.slo.set.reset.future") : st.active ? t("ob.slo.set.reset.active", { span }) : t("ob.slo.set.reset.ended")}
                        </Chip>
                        {!ro ? <LinkButton tone="muted" onClick={() => void undoReset(x)}>{t("ob.slo.set.reset.undo")}</LinkButton> : null}
                      </div>
                      <span className={styles.sloCellSub}>
                        {t("ob.slo.set.reset.line", { at: when(x.at), by: x.by ?? "—", ends: when(st.endsAt) })}
                      </span>
                      <span>{x.reason}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.stackMuted}>{t("ob.slo.set.reset.none")}</p>}
          </Panel>
        </Cell>

        <Cell span={12}>
          <Panel title={t("ob.slo.set.servicesTitle")} sub={t("ob.slo.set.servicesSub", { n: rows.length })} flush
            actions={<SearchInput label={t("ob.slo.set.find")} value={filter} onChange={setFilter} placeholder="namespace/app" />}
            footer={<span>{t("ob.slo.set.servicesFoot")}</span>}>
            <div className={styles.sloTableWrap}>
              <table className={styles.sloTable}>
                <thead>
                  <tr>
                    <th scope="col">{t("ob.slo.g.col.service")}</th>
                    <th scope="col">{t("ob.slo.set.availability")}</th>
                    <th scope="col">{t("ob.slo.set.threshold")}</th>
                    <th scope="col">{t("ob.slo.set.latencyTarget")}</th>
                    <th scope="col">{t("ob.slo.set.excludeUris")}</th>
                    <th scope="col">{t("ob.slo.set.leaveOut")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ key, measured }) => {
                    const v = draft.services[key] ?? EMPTY_SERVICE;
                    const inh = inherited(r, settings, key);
                    const set = !!r.settings.services?.[key];
                    return (
                      <tr key={key}>
                        <td>
                          <span className={styles.sloCellMain}>{key.slice(key.indexOf("/") + 1)}</span>
                          <span className={styles.sloCellSub}>
                            {key.slice(0, key.indexOf("/"))}
                            {measured ? ` · ${t(`ob.slo.state.${measured.state}`)}` : ` · ${t("ob.slo.set.notMeasured")}`}
                            {set ? ` · ${t("ob.slo.set.src.platform")}` : ""}
                          </span>
                        </td>
                        <td>
                          <Select label={t("ob.slo.set.availability")} hideLabel value={v.availability} disabled={ro} onChange={(x) => setSvc(key, { availability: x })}
                            options={targetOptions(inh.availability, v.availability)} />
                        </td>
                        <td>
                          <TextInput label={t("ob.slo.set.threshold")} hideLabel type="number" value={v.thresholdMs} disabled={ro} width={96}
                            placeholder={String(inh.latency.v.thresholdMs)} onChange={(x) => setSvc(key, { thresholdMs: x })}
                            hint={bad.has(`${key}.thresholdMs`) ? t("ob.slo.set.badThreshold") : undefined} />
                        </td>
                        <td>
                          <Select label={t("ob.slo.set.latencyTarget")} hideLabel value={v.latencyTarget} disabled={ro} onChange={(x) => setSvc(key, { latencyTarget: x })}
                            options={targetOptions({ v: inh.latency.v.target, source: inh.latency.source }, v.latencyTarget)} />
                        </td>
                        <td>
                          <TextInput label={t("ob.slo.set.excludeUris")} hideLabel value={v.excludeUris} disabled={ro} width={200} placeholder="—"
                            onChange={(x) => setSvc(key, { excludeUris: x })} hint={bad.has(`${key}.excludeUris`) ? t("ob.slo.set.badUris") : undefined} />
                        </td>
                        <td><Toggle checked={v.exclude} disabled={ro} onChange={(x) => setSvc(key, { exclude: x })}>{t("ob.slo.set.leaveOutShort")}</Toggle></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </Cell>

        {r.history.length > 0 && (
          <Cell span={12}>
            <Panel title={t("ob.slo.set.historyTitle")} sub={String(r.history.length)}>
              <ul className={styles.sloHistory}>
                {r.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    <span className={styles.sloCellSub}>{when(h.at)} · {h.by ?? "—"}</span>
                    <span><strong>{t(`ob.slo.set.action.${h.action}`)}</strong>{h.detail ? ` — ${h.detail}` : ""}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          </Cell>
        )}
      </Grid>
    </div>
  );
}
