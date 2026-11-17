"use client";

// 사례·런북 — the case and runbook forms (operators). Only the symptoms are required for a case; "resolved" asks
// for what fixed it. Pasted secrets are masked by the API when saved (it says how many).
import { useState } from "react";
import type { OpsCase, OpsFollowUp, OpsRunbook, OpsTimelineEntry, OpsTimelineKind } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { Button, FilterChip, LinkButton, Notice, Panel, Select, TextInput, Toggle } from "@/components/ui";
import {
  caseBody, caseProblems, emptyStep, newFollowUpId, runbookBody, runbookProblems, toLocalInput, type CaseForm, type RunbookForm,
} from "@/lib/opsKnowledge";
import { errText, useOpsCall } from "./shared";
import s from "./runbooks.module.css";

type Saved<T> = { item: T; redactions: number };

export function CaseEditor({ initial, id, rev, runbooks, clusters, onSaved, onCancel }: {
  initial: CaseForm; id: string | null; rev: number | null; runbooks: OpsRunbook[]; clusters: Array<{ id: string; name: string }>;
  onSaved: (c: OpsCase, redactions: number) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const call = useOpsCall();
  const [f, setF] = useState<CaseForm>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof CaseForm>(k: K) => (v: CaseForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const problems = caseProblems(f);
  const save = async () => {
    setBusy(true);
    try {
      const r = await call<Saved<OpsCase>>("PUT", "/api/ops/cases", id ? { id } : {}, caseBody(f, rev));
      setErr(null);
      onSaved(r.item, r.redactions);
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const toggleRunbook = (rid: string) => set("runbookIds")(f.runbookIds.includes(rid) ? f.runbookIds.filter((x) => x !== rid) : [...f.runbookIds, rid].slice(0, 10));
  return (
    <Panel title={id ? t("ops.kb.case.edit") : t("ops.kb.case.new")} footer={
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void save()} disabled={busy || problems.length > 0}>{t("ops.kb.save")}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{t("ops.kb.cancel")}</Button>
      </div>
    }>
      <div className={s.stack}>
        <TextInput label={t("ops.kb.f.title")} value={f.title} onChange={set("title")} maxLength={120} placeholder={t("ops.kb.f.titlePh")} />
        <div className={s.row2}>
          <Select label={t("ops.kb.f.status")} value={f.status} onChange={(v) => set("status")(v as CaseForm["status"])}
            options={(["open", "mitigated", "resolved"] as const).map((x) => ({ value: x, label: t(`ops.kb.status.${x}`) }))} />
          <Select label={t("ops.kb.f.severity")} value={f.severity} onChange={(v) => set("severity")(v as CaseForm["severity"])}
            options={(["sev1", "sev2", "sev3", "sev4"] as const).map((x) => ({ value: x, label: t(`ops.kb.sev.${x}`) }))} />
          <TextInput label={t("ops.kb.f.occurredAt")} type="datetime-local" value={f.occurredAt} onChange={set("occurredAt")} />
        </div>
        <TextInput label={t("ops.kb.f.symptoms")} rows={6} value={f.symptoms} onChange={set("symptoms")} maxLength={8000} placeholder={t("ops.kb.f.symptomsPh")} hint={t("ops.kb.f.maskHint")} />
        <TextInput label={t("ops.kb.f.cause")} rows={4} value={f.cause} onChange={set("cause")} maxLength={8000} />
        <TextInput label={t("ops.kb.f.resolution")} rows={4} value={f.resolution} onChange={set("resolution")} maxLength={8000}
          hint={f.status === "resolved" ? t("ops.kb.f.resolutionNeeded") : undefined} />
        <TextInput label={t("ops.kb.f.lessons")} rows={3} value={f.lessons} onChange={set("lessons")} maxLength={4000} />
        <div className={s.row2}>
          <Select label={t("ops.kb.f.cluster")} value={f.clusterId} onChange={(v) => setF((p) => ({ ...p, clusterId: v, clusterName: clusters.find((c) => c.id === v)?.name ?? "" }))}
            options={[{ value: "", label: t("ops.kb.f.clusterNone") }, ...clusters.map((c) => ({ value: c.id, label: c.name }))]} />
          <TextInput label={t("ops.kb.f.namespace")} value={f.namespace} onChange={set("namespace")} maxLength={253} />
          <TextInput label={t("ops.kb.f.workload")} value={f.workload} onChange={set("workload")} maxLength={253} />
          <TextInput label={t("ops.kb.f.resourceType")} value={f.resourceType} onChange={set("resourceType")} maxLength={253} placeholder="Microsoft.ContainerService/managedClusters" />
        </div>
        <div className={s.row2}>
          <TextInput label={t("ops.kb.f.tags")} value={f.tags} onChange={set("tags")} hint={t("ops.kb.f.listHint")} />
          <TextInput label={t("ops.kb.f.keywords")} value={f.keywords} onChange={set("keywords")} hint={t("ops.kb.f.keywordsHint")} />
          <TextInput label={t("ops.kb.f.team")} value={f.team} onChange={set("team")} maxLength={60} />
        </div>
        {f.alertRule ? <p className={s.muted}>{t("ops.kb.f.fromAlert", { rule: f.alertRule })}{f.recurrenceKey ? ` · ${t("ops.kb.f.fromGroup")}` : ""}</p> : null}
        <TimelineEditor list={f.timeline} onChange={set("timeline")} />
        <FollowUpEditor list={f.followUps} onChange={set("followUps")} />
        <div className={s.field}>
          <span className={s.sub}>{t("ops.kb.f.runbooks")}</span>
          <div className={s.tags}>
            {runbooks.length ? runbooks.map((r) => <FilterChip key={r.id} pressed={f.runbookIds.includes(r.id)} onClick={() => toggleRunbook(r.id)}>{r.title}</FilterChip>)
              : <span className={s.muted}>{t("ops.kb.f.noRunbooks")}</span>}
          </div>
        </div>
        {problems.length ? <ul className={s.problems}>{problems.map((p) => <li key={p}>{t(p)}</li>)}</ul> : null}
        {err ? <Notice tone="danger">{err}</Notice> : null}
      </div>
    </Panel>
  );
}

export function RunbookEditor({ initial, id, rev, onSaved, onCancel }: {
  initial: RunbookForm; id: string | null; rev: number | null; onSaved: (r: OpsRunbook, redactions: number) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const call = useOpsCall();
  const [f, setF] = useState<RunbookForm>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof RunbookForm>(k: K) => (v: RunbookForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const setStep = (i: number, k: "title" | "detail" | "command" | "check", v: string) =>
    setF((p) => ({ ...p, steps: p.steps.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }));
  const move = (i: number, d: -1 | 1) => setF((p) => {
    const steps = [...p.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return p;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    return { ...p, steps };
  });
  const problems = runbookProblems(f);
  const save = async () => {
    setBusy(true);
    try {
      const r = await call<Saved<OpsRunbook>>("PUT", "/api/ops/runbooks", id ? { id } : {}, runbookBody(f, rev));
      setErr(null);
      onSaved(r.item, r.redactions);
    } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  return (
    <Panel title={id ? t("ops.kb.rb.edit") : t("ops.kb.rb.new")} footer={
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void save()} disabled={busy || problems.length > 0}>{t("ops.kb.save")}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{t("ops.kb.cancel")}</Button>
      </div>
    }>
      <div className={s.stack}>
        <TextInput label={t("ops.kb.f.title")} value={f.title} onChange={set("title")} maxLength={120} placeholder={t("ops.kb.f.rbTitlePh")} />
        <TextInput label={t("ops.kb.f.when")} rows={3} value={f.when} onChange={set("when")} maxLength={2000} placeholder={t("ops.kb.f.whenPh")} />
        <div className={s.row2}>
          <TextInput label={t("ops.kb.f.alertRules")} value={f.alertRules} onChange={set("alertRules")} hint={t("ops.kb.f.alertRulesHint")} />
          <TextInput label={t("ops.kb.f.keywords")} value={f.keywords} onChange={set("keywords")} hint={t("ops.kb.f.rbKeywordsHint")} />
          <TextInput label={t("ops.kb.f.tags")} value={f.tags} onChange={set("tags")} hint={t("ops.kb.f.listHint")} />
          <TextInput label={t("ops.kb.f.team")} value={f.team} onChange={set("team")} maxLength={60} />
          <TextInput label={t("ops.kb.f.verifiedAt")} type="datetime-local" value={f.verifiedAt} onChange={set("verifiedAt")} />
        </div>
        {f.steps.map((st, i) => (
          <div key={i} className={s.stepEdit}>
            <div className={s.stepHead}>
              <span>{t("ops.kb.f.step", { n: i + 1 })}</span>
              <div className={s.actions}>
                <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} ariaLabel={t("ops.kb.f.stepUp")}>↑</Button>
                <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === f.steps.length - 1} ariaLabel={t("ops.kb.f.stepDown")}>↓</Button>
                <Button size="sm" variant="ghost" onClick={() => setF((p) => ({ ...p, steps: p.steps.filter((_, j) => j !== i) }))} disabled={f.steps.length === 1}>{t("ops.kb.f.stepRemove")}</Button>
              </div>
            </div>
            <TextInput label={t("ops.kb.f.stepTitle")} value={st.title} onChange={(v) => setStep(i, "title", v)} maxLength={160} />
            <TextInput label={t("ops.kb.f.stepDetail")} rows={2} value={st.detail ?? ""} onChange={(v) => setStep(i, "detail", v)} maxLength={4000} />
            <TextInput label={t("ops.kb.f.stepCommand")} rows={2} value={st.command ?? ""} onChange={(v) => setStep(i, "command", v)} maxLength={4000} hint={t("ops.kb.f.commandHint")} />
            <TextInput label={t("ops.kb.f.stepCheck")} value={st.check ?? ""} onChange={(v) => setStep(i, "check", v)} maxLength={1000} />
          </div>
        ))}
        <div><Button size="sm" onClick={() => setF((p) => ({ ...p, steps: [...p.steps, emptyStep()].slice(0, 30) }))} disabled={f.steps.length >= 30}>{t("ops.kb.f.stepAdd")}</Button></div>
        <TextInput label={t("ops.kb.f.rollback")} rows={3} value={f.rollback} onChange={set("rollback")} maxLength={4000} />
        {problems.length ? <ul className={s.problems}>{problems.map((p) => <li key={p}>{t(p)}</li>)}</ul> : null}
        {err ? <Notice tone="danger">{err}</Notice> : null}
      </div>
    </Panel>
  );
}

const TIMELINE_KINDS: OpsTimelineKind[] = ["alert", "change", "action", "note", "status"];
const fromLocal = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

/** The incident's story: lines kept in time order (the API sorts them too) */
function TimelineEditor({ list, onChange }: { list: OpsTimelineEntry[]; onChange: (l: OpsTimelineEntry[]) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<OpsTimelineKind>("action");
  const [at, setAt] = useState(() => toLocalInput(new Date().toISOString()));
  const [text, setText] = useState("");
  const add = () => {
    const iso = fromLocal(at);
    if (!iso || !text.trim()) return;
    onChange([...list, { at: iso, kind, text: text.trim().slice(0, 1000) }].sort((a, z) => (a.at < z.at ? -1 : a.at > z.at ? 1 : 0)).slice(0, 200));
    setText("");
  };
  return (
    <div className={s.field}>
      <span className={s.sub}>{t("ops.kb.tl.title")}</span>
      {list.length ? (
        <ol className={s.timeline}>
          {list.map((e, i) => (
            <li key={`${e.at}:${i}`}>
              <span className={s.tlWhen}>{new Date(e.at).toLocaleString()}</span>
              <span className={s.tlKind}>{t(`ops.kb.tl.kind.${e.kind}`)}</span>
              <span className={s.tlText}>{e.text}</span>
              <LinkButton tone="muted" onClick={() => onChange(list.filter((_, j) => j !== i))}>{t("ops.kb.remove")}</LinkButton>
            </li>
          ))}
        </ol>
      ) : <span className={s.muted}>{t("ops.kb.tl.none")}</span>}
      <div className={s.row2}>
        <Select label={t("ops.kb.tl.kind")} value={kind} onChange={(v) => setKind(v as OpsTimelineKind)} options={TIMELINE_KINDS.map((k) => ({ value: k, label: t(`ops.kb.tl.kind.${k}`) }))} />
        <TextInput label={t("ops.kb.tl.at")} type="datetime-local" value={at} onChange={setAt} />
        <TextInput label={t("ops.kb.tl.text")} value={text} onChange={setText} maxLength={1000} placeholder={t("ops.kb.tl.textPh")} />
        <Button size="sm" onClick={add} disabled={!text.trim() || !fromLocal(at)}>{t("ops.kb.tl.add")}</Button>
      </div>
    </div>
  );
}

/** What must change so it does not happen again — owner, due day, done */
function FollowUpEditor({ list, onChange }: { list: OpsFollowUp[]; onChange: (l: OpsFollowUp[]) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");
  const add = () => {
    if (!title.trim() || list.length >= 30) return;
    onChange([...list, { id: newFollowUpId(list), title: title.trim().slice(0, 300), status: "open", ...(owner.trim() ? { owner: owner.trim() } : {}), ...(due ? { due } : {}) }]);
    setTitle(""); setOwner(""); setDue("");
  };
  const patch = (id: string, p: Partial<OpsFollowUp>) => onChange(list.map((f) => (f.id === id ? { ...f, ...p } : f)));
  return (
    <div className={s.field}>
      <span className={s.sub}>{t("ops.kb.fu.title")}</span>
      {list.length ? (
        <ul className={s.followUps}>
          {list.map((f) => (
            <li key={f.id}>
              <Toggle checked={f.status === "done"}
                onChange={(on) => patch(f.id, on ? { status: "done", doneAt: new Date().toISOString() } : { status: "open", doneAt: undefined })}>{f.title}</Toggle>
              <span className={s.sub}>{[f.owner, f.due ? t("ops.kb.fu.dueOn", { d: f.due }) : ""].filter(Boolean).join(" · ")}</span>
              <LinkButton tone="muted" onClick={() => onChange(list.filter((x) => x.id !== f.id))}>{t("ops.kb.remove")}</LinkButton>
            </li>
          ))}
        </ul>
      ) : <span className={s.muted}>{t("ops.kb.fu.none")}</span>}
      <div className={s.row2}>
        <TextInput label={t("ops.kb.fu.what")} value={title} onChange={setTitle} maxLength={300} placeholder={t("ops.kb.fu.whatPh")} />
        <TextInput label={t("ops.kb.fu.owner")} value={owner} onChange={setOwner} maxLength={120} />
        <TextInput label={t("ops.kb.fu.due")} type="datetime-local" value={due ? `${due}T00:00` : ""} onChange={(v) => setDue(v.slice(0, 10))} />
        <Button size="sm" onClick={add} disabled={!title.trim() || list.length >= 30}>{t("ops.kb.fu.add")}</Button>
      </div>
    </div>
  );
}
