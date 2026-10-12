"use client";

import { useRef, useState } from "react";
import type { AttackEdge, AttackNode, PolicyFinding, PolicyInsightsResponse, RemediationAction, RiskIssue } from "@aud/types";
import { useMediaQuery } from "@/lib/useBrowserState";
import { COLS, EVK, KIND_LABEL, TYPE_LABEL, confOf, edgeKey, evidenceOf, flowNote, hubbleLabel, issueNum, type InsightsNav } from "./model";
import { EvidenceChip, Inspector, Pill, type InspectorModel, type InspectorRow } from "./Inspector";
import { AttackGraph, AttackTable, type GraphSel } from "./AttackGraph";
import styles from "./insights.module.css";

type Props = {
  data: PolicyInsightsResponse;
  findings: PolicyFinding[];
  selectedId: string;
  onSelect: (id: string) => void;
  checked: ReadonlySet<string>;
  onToggleAction: (id: string, on: boolean) => void;
  nav: InsightsNav;
};

type Owner = "all" | RiskIssue["ownerGroup"];
const OWNERS: Array<[Owner, string]> = [["all", "전체"], ["mine", "내 워크로드"], ["addon", "애드온"], ["azure", "Azure 설정"]];
const SEV_LABEL = { crit: "위험", warn: "주의" } as const;

export function issueState(issue: RiskIssue, checked: ReadonlySet<string>): "open" | "reduced" | "closed" {
  const resolved = new Set(issue.actions.filter((a) => checked.has(a.id)).flatMap((a) => a.closes));
  if (issue.findingIds.length && issue.findingIds.every((f) => resolved.has(f))) return "closed";
  if (issue.actions.some((a) => checked.has(a.id))) return "reduced";
  return "open";
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <pre className={styles.code}>
      {code.split("\n").map((l, i) => {
        const cls = /^\+ /.test(l) ? styles.codeAdd : /^- /.test(l) ? styles.codeDel : /^\s*#/.test(l) ? styles.codeCm : undefined;
        return <span key={i} className={cls}>{l}{"\n"}</span>;
      })}
    </pre>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
  }
}

function ActionRow({ a, checked, onToggle }: { a: RemediationAction; checked: boolean; onToggle: (on: boolean) => void }) {
  return (
    <label className={styles.action}>
      <input type="checkbox" data-act={a.id} checked={checked} onChange={(e) => onToggle(e.target.checked)} />
      <div>
        <div className={styles.actionT}>{a.title}</div>
        <div className={styles.actionD}>{a.desc}</div>
      </div>
      <div className={styles.effect}>
        <Pill tone={a.risk}>수정: {a.riskLabel}</Pill>
        <span className={styles.muted}>{a.effect === "closed" ? `점검 ${a.closes.length}건 해소${a.cuts.length ? " · 경로 차단" : ""}` : a.effect === "exception" ? "예외 처리" : "경로 축소(닫힘 아님)"}</span>
      </div>
    </label>
  );
}

function ticketText(issue: RiskIssue, data: PolicyInsightsResponse, checked: ReadonlySet<string>): string {
  const acts = issue.actions.filter((a) => checked.has(a.id));
  return [
    `## [${SEV_LABEL[issue.sev]}] ${issue.title}`, "",
    `- 클러스터: ${data.containment.cluster.name} (${data.containment.cluster.location})`,
    `- 근거: ${confOf(issue, data.network.coverage)}`,
    `- 관련 점검: ${issue.findingIds.map((f) => f.split(":")[0]).join(", ") || "-"}`,
    `- 소유: ${issue.owner}`, "", "### 조치",
    ...(acts.length ? acts : issue.actions).map((a) => `- [ ] ${a.title} — 수정 위험: ${a.riskLabel}`), "",
    "### 롤백", "- 적용한 리소스를 이전 매니페스트로 되돌리고 Hubble DROPPED 흐름을 확인",
  ].join("\n");
}

export function RiskCombos({ data, findings, selectedId, onSelect, checked, onToggleAction, nav }: Props) {
  const [owner, setOwner] = useState<Owner>("all");
  const [quickOnly, setQuickOnly] = useState(false);
  const [graphSel, setGraphSel] = useState<(GraphSel & { issue: string }) | null>(null);
  const [viewChoice, setViewChoice] = useState<"graph" | "table" | null>(null);
  const [fixTab, setFixTab] = useState<"code" | "ticket">("code");
  const [toast, setToast] = useState("");
  const narrow = useMediaQuery("(max-width: 640px)");
  const view = viewChoice ?? (narrow ? "table" : "graph");
  const els = useRef(new Map<string, Element>());
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const register = (key: string, el: Element | null) => { if (el) els.current.set(key, el); else els.current.delete(key); };

  const issue = data.issues.find((i) => i.id === selectedId) ?? data.issues[0];
  const sel = graphSel && graphSel.issue === issue?.id ? graphSel : null;
  const matches = (i: RiskIssue) => (owner === "all" || i.ownerGroup === owner) && (!quickOnly || i.actions.some((a) => a.risk === "ok"));
  const shown = data.issues.filter(matches);
  const hidden = data.issues.filter((i) => !matches(i));
  const security = findings.filter((f) => !f.system && f.severity !== "info" && ["psa", "networkPolicy", "rbac"].includes(f.category));
  const resolvedAll = new Set(data.issues.flatMap((i) => i.actions).filter((a) => checked.has(a.id)).flatMap((a) => a.closes));
  const cutDone = new Set(data.issues.flatMap((i) => i.actions).filter((a) => checked.has(a.id)).flatMap((a) => a.cuts));
  const findingById = new Map(findings.map((f) => [f.id, f]));

  if (!issue) {
    return <div className={styles.notice}>서로 이어지는 위험 조합이 발견되지 않았습니다. 개별 점검 결과는 &lsquo;점검 결과&rsquo; 탭에서 확인하세요.</div>;
  }
  const num = (id: string) => issueNum(data.issues.findIndex((i) => i.id === id));

  const select = (id: string, focusCard = false) => {
    onSelect(id);
    if (focusCard) requestAnimationFrame(() => cardRefs.current.get(id)?.focus());
  };
  const pick = (s: GraphSel) => {
    const same = sel && sel.kind === s.kind && sel.id === s.id;
    setGraphSel(same ? null : { ...s, issue: issue.id });
  };
  const closeDetail = () => {
    const prev = sel;
    setGraphSel(null);
    if (prev) (els.current.get(`${prev.kind}:${prev.id}`) as HTMLElement | SVGElement | undefined)?.focus();
  };
  const toggleAct = (id: string, on: boolean) => onToggleAction(id, on);
  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(""), 2500); };

  const refLinks = (refs: string[]) => refs.flatMap((id) => [
    ...(data.rows.some((r) => r.id === id) ? [{ label: `히트맵에서 보기 · ${data.rows.find((r) => r.id === id)!.name}`, onClick: () => nav.openHeatRow(id) }] : []),
    ...(data.network.nodes.some((n) => n.id === id) ? [{ label: `네트워크 맵에서 보기 · ${data.network.nodes.find((n) => n.id === id)!.label}`, onClick: () => nav.openNet(id) }] : []),
  ]).filter((l, i, a) => a.findIndex((x) => x.label === l.label) === i);

  const nodeModel = (n: AttackNode): InspectorModel => {
    const conn = issue.edges.filter((e) => e.from === n.id || e.to === n.id);
    const byId = new Map(issue.nodes.map((x) => [x.id, x]));
    const acts = issue.actions.filter((a) => a.cuts.some((c) => c.split(">").includes(n.id)) || conn.some((e) => e.cut === a.id));
    return {
      id: `gd-${issue.id}-${n.id}`,
      kicker: `${COLS[n.col]} · ${TYPE_LABEL[n.type] ?? n.type}`,
      title: n.label,
      sub: n.sub,
      chips: <>{n.unk && <EvidenceChip ev="unk" text="미확인" />}{(n.badges ?? []).map((b) => <Pill key={b.what} tone="ev">{b.n} {b.what}</Pill>)}</>,
      callouts: (n.notes ?? []).map((t) => ({ tone: "warn" as const, content: `확인 필요 — ${t}` })),
      sections: [
        n.facts.length ? { h: "사실 · 값 | 근거 | 출처", rows: n.facts as InspectorRow[] } : { h: "사실", body: <div className={styles.muted}>이 노드에 대해 수집된 추가 사실이 없습니다.</div> },
        { h: `연결 ${conn.length}`, body: (
          <ul className={styles.list}>
            {conn.map((e) => (
              <li key={edgeKey(e)}>
                <span>{e.from === n.id ? `→ ${byId.get(e.to)?.label}` : `← ${byId.get(e.from)?.label}`}</span>
                <span className={styles.muted}>{e.label}</span>
                <EvidenceChip ev={e.ev} />
                {e.cut && <span className={styles.cut} data-done={cutDone.has(edgeKey(e)) || undefined}>{cutDone.has(edgeKey(e)) ? "✓ 차단됨" : "⊗ 권장 차단"}</span>}
              </li>
            ))}
          </ul>
        ) },
        acts.length > 0 && { h: "이 지점을 끊는 조치", body: <>{acts.map((a) => <ActionRow key={a.id} a={a} checked={checked.has(a.id)} onToggle={(on) => toggleAct(a.id, on)} />)}</> },
        { h: `이 조합의 점검 ${issue.findingIds.length}건 (노드 단위 아님)`, body: (
          <ul className={styles.list}>
            {issue.findingIds.map((id) => { const f = findingById.get(id); return <li key={id}><span className={styles.mono}>{f?.ruleId ?? id}</span><span>{f?.title}</span><span className={styles.muted}>{f?.namespace ?? f?.resource?.name ?? ""}</span></li>; })}
            {!issue.findingIds.length && <li className={styles.muted}>연결된 점검 없음</li>}
          </ul>
        ) },
        n.cmd ? { h: "확인 명령 (읽기 전용)", body: (
          <details>
            <summary className={styles.muted}>권한 실측 — kubectl auth can-i</summary>
            <CodeBlock code={n.cmd} />
            <div className={styles.copyRow}><button className={styles.btnGhost} onClick={() => copyText(n.cmd!).then((ok) => flash(ok ? "명령을 복사했습니다" : "복사하지 못했습니다"))}>명령 복사</button></div>
          </details>
        ) } : null,
      ],
      links: refLinks(n.refs),
    };
  };

  const edgeModel = (e: AttackEdge): InspectorModel => {
    const byId = new Map(issue.nodes.map((x) => [x.id, x]));
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    const act = e.cut ? issue.actions.find((x) => x.id === e.cut) : undefined;
    const src = { obs: `Hubble · ${hubbleLabel(data.network.coverage)} · ${flowNote(data.network.coverage)} · 연결 시작 패킷`, perm: `RBAC 바인딩·역할 — ${e.label || "-"}`, cfg: `구성 필드 — ${e.label || "-"}`, unk: e.why ?? "수집되지 않은 연결고리 — 추가 수집 시 확정" }[e.ev];
    return {
      id: `ge-${issue.id}-${edgeKey(e)}`,
      kicker: `경로 간선 · ${EVK[e.ev]}`,
      title: `${a.label} → ${b.label}`,
      sub: e.label,
      chips: <EvidenceChip ev={e.ev} />,
      sections: [
        { h: "근거", rows: [
          { k: "등급", v: { obs: "실제 트래픽이 관측됨 (정상 트래픽 포함)", perm: "권한이 부여되어 있음 (사용 여부와 무관)", cfg: "구성상 가능함", unk: "연결고리가 확인되지 않음" }[e.ev], ev: e.ev },
          { k: "원문", v: e.label || "-", mono: true },
          { k: "출처", v: src },
        ] },
        act ? { h: `권장 차단${checked.has(act.id) ? " · 적용됨" : ""}`, body: <ActionRow a={act} checked={checked.has(act.id)} onToggle={(on) => toggleAct(act.id, on)} /> }
          : { h: "권장 차단", body: <div className={styles.muted}>이 간선에 지정된 차단 지점이 없습니다.</div> },
      ],
      links: refLinks([...a.refs, ...b.refs]),
    };
  };

  const detail = sel
    ? sel.kind === "node"
      ? (() => { const n = issue.nodes.find((x) => x.id === sel.id); return n ? nodeModel(n) : null; })()
      : (() => { const e = issue.edges.find((x) => edgeKey(x) === sel.id); return e ? edgeModel(e) : null; })()
    : null;

  const st = issueState(issue, checked);
  const openCount = data.issues.filter((i) => issueState(i, checked) !== "closed").length;
  const reduced = data.issues.filter((i) => issueState(i, checked) === "reduced").length;
  const cuts = issue.edges.filter((e) => e.cut);
  const sim = (
    <div className={styles.sim}>
      <span>이 위험 조합: <b>{st === "closed" ? "닫힘" : st === "reduced" ? "축소 — 묶인 점검이 남아 있음" : "열림"}</b> · 권장 차단 {cuts.length}곳 중 <b>{cuts.filter((e) => cutDone.has(edgeKey(e))).length}</b>곳 차단</span>
      <span>전체: 위험 조합 <b>{data.issues.length} → {openCount}</b>{reduced ? ` · 축소 ${reduced}` : ""} · 해결된 보안 점검 {[...resolvedAll].filter((f) => security.some((s) => s.id === f)).length}/{security.length}</span>
    </div>
  );

  return (
    <div className={styles.md}>
      <div className={styles.queue}>
        <div className={styles.queueIn}>
          <div className={styles.queueH}>
            <h3>위험 조합 <span className={styles.muted}>{openCount}건</span></h3>
            <div className={styles.ctrls}>
              <button className={styles.fchip} aria-pressed={quickOnly} onClick={() => setQuickOnly(!quickOnly)}>빠른 성과만</button>
              {OWNERS.map(([k, l]) => <button key={k} className={styles.fchip} aria-pressed={owner === k} onClick={() => setOwner(k)}>{l}</button>)}
            </div>
          </div>
          {shown.map((i) => {
            const s = issueState(i, checked);
            return (
              <button
                key={i.id}
                ref={(el) => { if (el) cardRefs.current.set(i.id, el); else cardRefs.current.delete(i.id); }}
                className={styles.card}
                data-sev={i.sev}
                data-closed={s === "closed" || undefined}
                aria-pressed={issue.id === i.id}
                onClick={() => select(i.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const k = shown.findIndex((x) => x.id === i.id) + (e.key === "ArrowDown" ? 1 : -1);
                  const next = shown[Math.max(0, Math.min(shown.length - 1, k))];
                  if (next) select(next.id, true);
                }}
              >
                <div className={styles.cardTop}>
                  <Pill tone={i.sev}>{num(i.id)} {SEV_LABEL[i.sev]}</Pill>
                  <span className={styles.cardNum}>{KIND_LABEL[i.kind]} · 점검 {i.findingIds.length}건{s === "closed" ? " · 닫힘" : s === "reduced" ? " · 축소" : ""}</span>
                </div>
                <div className={styles.cardTitle}>{i.title}</div>
                <div className={styles.cardMeta}>
                  {evidenceOf(i).map(([k, t]) => <Pill key={t} tone={k === "unk" ? "unk" : "ev"}>{k === "unk" ? "? " : ""}{t}</Pill>)}
                  {i.actions[0] && <Pill tone={i.actions[0].risk} title="대표 조치의 수정 시 운영 영향">수정: {i.actions[0].riskLabel}</Pill>}
                </div>
                <div className={styles.owner}>소유: {i.owner}</div>
              </button>
            );
          })}
          {shown.length === 0 && <div className={styles.muted}>조건에 맞는 위험 조합이 없습니다.</div>}
          {hidden.length > 0 && (
            <>
              <div className={styles.dimH}>
                <span>필터 밖 위험 {hidden.length}건</span>
                <button className={styles.linkish} onClick={() => { setOwner("all"); setQuickOnly(false); }}>필터 해제</button>
              </div>
              {hidden.map((i) => (
                <button key={i.id} className={`${styles.card} ${styles.dim}`} data-sev={i.sev} aria-label={`${num(i.id)} ${KIND_LABEL[i.kind]}: ${i.title} — 필터를 해제하고 보기`}
                  onClick={() => { setOwner("all"); setQuickOnly(false); select(i.id, true); }}>
                  <span className={styles.cardNum}>{num(i.id)}</span>
                  <span className={styles.dimT}>{KIND_LABEL[i.kind]} · {i.title}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <section className={`${styles.panel} ${styles.gPanel}`} aria-label="공격 경로">
        <div className={styles.panelH}>
          <h3>공격 경로 · 근거 등급</h3>
          <div className={styles.ctrls}>
            <span className={styles.sub}>경로 근거: {confOf(issue, data.network.coverage)}</span>
            <div className={styles.toggle}>
              <button aria-pressed={view === "graph"} onClick={() => setViewChoice("graph")}>그래프</button>
              <button aria-pressed={view === "table"} onClick={() => setViewChoice("table")}>표</button>
            </div>
          </div>
        </div>
        <div className={styles.panelB}>
          <div className={styles.cardTitle} style={{ fontSize: 13.5, marginBottom: 6, WebkitLineClamp: "unset" }}>{num(issue.id)} {issue.title}</div>
          {view === "graph" ? (
            <div className={styles.graphWrap}>
              <AttackGraph issue={issue} sel={sel} cutDone={cutDone} onPick={pick} onEscape={closeDetail} register={register} />
            </div>
          ) : (
            <AttackTable issue={issue} onPick={pick} />
          )}
          {detail && (
            <div className={styles.detailHost} aria-live="polite">
              <Inspector model={detail} onClose={closeDetail} cols />
            </div>
          )}
          <div className={styles.gLegend}>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-obs)" strokeWidth="2.5" /></svg>통신 관측(정상 트래픽 포함)</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-perm)" strokeWidth="2" strokeDasharray="7 4" /></svg>RBAC 권한</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--edge-cfg)" strokeWidth="2" strokeDasharray="2 3" /></svg>구성·마운트</span>
            <span><svg width="30" height="8"><line x1="0" y1="4" x2="30" y2="4" stroke="var(--unk)" strokeWidth="2" strokeDasharray="2 3" opacity="0.6" /></svg>추정·미확인 (?)</span>
            <span>노드·간선 클릭 또는 Tab+Enter → 상세 · Esc 닫기</span>
          </div>
          {sim}
        </div>
      </section>

      <section className={`${styles.panel} ${styles.fPanel}`} aria-label="출처에서 수정">
        <div className={styles.panelH}><h3>출처에서 수정</h3><span className={styles.sub}>체크하면 그래프와 판정 숫자에 반영됩니다 (이 화면 안의 시뮬레이션)</span></div>
        <div className={styles.panelB}>
          <div className={styles.fixGrid}>
            <div>
              <h4>조치</h4>
              {issue.actions.map((a) => <ActionRow key={a.id} a={a} checked={checked.has(a.id)} onToggle={(on) => toggleAct(a.id, on)} />)}
            </div>
            <div>
              <div className={styles.tabs} role="tablist">
                <button role="tab" aria-selected={fixTab === "code"} onClick={() => setFixTab("code")}>YAML · 명령</button>
                <button role="tab" aria-selected={fixTab === "ticket"} onClick={() => setFixTab("ticket")}>티켓 초안</button>
              </div>
              {fixTab === "code" ? (
                issue.actions.map((a, n) => (
                  <details key={a.id} className={styles.codeBlk} open={n === 0 || checked.has(a.id) || undefined}>
                    <summary>{a.title}</summary>
                    <CodeBlock code={a.code} />
                  </details>
                ))
              ) : (
                <>
                  <CodeBlock code={ticketText(issue, data, checked)} />
                  <div className={styles.copyRow}>
                    <span className={styles.muted} aria-live="polite">{toast}</span>
                    <button className={styles.btnGhost} onClick={() => copyText(ticketText(issue, data, checked)).then((ok) => flash(ok ? "티켓 초안을 복사했습니다" : "복사하지 못했습니다"))}>티켓 초안 복사</button>
                  </div>
                </>
              )}
            </div>
          </div>
          {sim}
          {toast && fixTab === "code" && <div className={styles.note} aria-live="polite">{toast}</div>}
        </div>
      </section>
    </div>
  );
}
