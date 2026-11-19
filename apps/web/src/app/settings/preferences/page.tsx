"use client";

// 설정 › 보기 설정 (2026-11-19) — Azure Portal's "포털 설정" for this platform: one person's own view, kept in this
// browser (never sent to the API, never shared).
//   • 디렉터리 + 구독  the clouds this platform reads — Azure directories (the connections the API declares, with their
//                      subscriptions) · AWS accounts · Google Cloud projects (said plainly when the platform cannot read
//                      them yet — no invented list); the subscription filter (Portal's 고급 필터: every screen's scope
//                      bar and lists inherit it) and the subscription a new tab opens on
//   • 모양            theme (자동 · 밝게 · 어둡게 — lib/displayPrefs), menu (고정 · 서랍 — lib/viewPrefs), density
//   • 언어            한국어 · English (lib/i18n) with how dates and numbers read in it
// Choices are radio cards (a native radio group: arrow keys, one tab stop) — no hand-made buttons.

import { Suspense, type ReactNode } from "react";
import type { AzureConnectionOption, AzureSubscriptionOption, CloudProvider } from "@aud/types";
import { dateLocale, useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/useMe";
import { useSubscriptions } from "@/lib/useSubscriptions";
import { useQueryParam } from "@/lib/useQueryParam";
import { useDisplayPrefs, type Density, type Theme } from "@/lib/displayPrefs";
import { useViewPrefs, visibleSubscriptions, type MenuMode } from "@/lib/viewPrefs";
import { directoriesOf, languageName, PROVIDER_SCOPE } from "@/lib/prefsView";
import { Chip, EmptyState, ErrorNotice, LinkButton, LoadingState, Notice, PageHeader, Panel, Select, Tabs, Toggle } from "@/components/ui";
import st from "./prefs.module.css";

type Tab = "directory" | "appearance" | "language";
const TABS: Tab[] = ["directory", "appearance", "language"];

export default function PreferencesPage() {
  return <Suspense fallback={<LoadingState />}><Preferences /></Suspense>;
}

function Preferences() {
  const { t } = useI18n();
  const [tab, setTab] = useQueryParam<Tab>("tab", TABS, "directory");
  return (
    <div className={st.page}>
      <PageHeader />
      <Notice tone="info">{t("pref.notice")}</Notice>
      <Tabs label={t("nav.item.preferences")} value={tab} onChange={setTab}
        items={TABS.map((id) => ({ id, label: t(`pref.tab.${id}`) }))} />
      {tab === "directory" ? <DirectoryTab /> : tab === "appearance" ? <AppearanceTab /> : <LanguageTab />}
    </div>
  );
}

/** A radio group drawn as cards — `value` is the chosen one */
function Choices<K extends string>({ name, label, value, onChange, items }: {
  name: string; label: string; value: K; onChange: (v: K) => void;
  items: Array<{ id: K; title: string; hint?: string; preview?: ReactNode }>;
}) {
  return (
    <fieldset className={st.choices}>
      <legend className={st.legend}>{label}</legend>
      <div className={st.cards}>
        {items.map((it) => (
          <label key={it.id} className={st.card} data-checked={it.id === value || undefined}>
            <input type="radio" name={name} value={it.id} checked={it.id === value} onChange={() => onChange(it.id)} />
            {it.preview ? <span className={st.preview} aria-hidden="true">{it.preview}</span> : null}
            <span className={st.cardTitle}>{it.title}</span>
            {it.hint ? <span className={st.cardHint}>{it.hint}</span> : null}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// ── 디렉터리 + 구독 ──

function DirectoryTab() {
  const { t } = useI18n();
  const me = useMe();
  const subs = useSubscriptions();
  const [prefs, save] = useViewPrefs();
  const connections: AzureConnectionOption[] = me.data?.connections ?? [];
  const current = subs.all.find((s) => s.subscriptionId === subs.subscriptionId)?.connectionKey ?? null;
  const dirs = directoriesOf(connections, subs.all);
  const vis = visibleSubscriptions(subs.all, prefs);
  const hidden = new Set(prefs.hidden);
  const setHidden = (ids: string[], hide: boolean) => {
    const next = new Set(prefs.hidden);
    for (const id of ids) { if (hide) next.add(id.toLowerCase()); else next.delete(id.toLowerCase()); }
    save({ hidden: [...next] });
  };
  const signedOut = me.data?.anonymous === true;

  return (
    <div className={st.stack}>
      <Panel title={t("pref.dir.title")} sub={t("pref.dir.sub")} flush>
        {me.error ? <div className={st.pad}><ErrorNotice error={me.error} /></div> : !me.data ? <LoadingState /> : (
          <table className={st.table}>
            <thead>
              <tr>
                <th scope="col">{t("pref.dir.col.cloud")}</th>
                <th scope="col">{t("pref.dir.col.directory")}</th>
                <th scope="col">{t("pref.dir.col.id")}</th>
                <th scope="col">{t("pref.dir.col.mode")}</th>
                <th scope="col">{t("pref.dir.col.scopes")}</th>
              </tr>
            </thead>
            <tbody>
              {dirs.map((d) => (
                <tr key={d.key} data-current={d.key === current || undefined}>
                  <td><CloudName provider="azure" /></td>
                  <td>
                    <span className={st.main}>{d.directory}</span>
                    <span className={st.sub}>{d.name}{d.key === current ? <Chip level="info" glyph={false}>{t("pref.dir.current")}</Chip> : null}</span>
                  </td>
                  <td className={st.mono}>…{d.idTail}</td>
                  <td>{t(`pref.dir.mode.${d.mode}`)}</td>
                  <td>{t("pref.dir.subscriptions", { n: d.subscriptions })}</td>
                </tr>
              ))}
              {!dirs.length ? (
                <tr><td><CloudName provider="azure" /></td><td colSpan={4} className={st.none}>{signedOut ? t("pref.dir.signin") : t("pref.dir.noAzure")}</td></tr>
              ) : null}
              {(["aws", "gcp"] as const).map((p) => (
                <tr key={p} data-unsupported>
                  <td><CloudName provider={p} /></td>
                  <td colSpan={4} className={st.none}>{t(`pref.dir.unsupported.${p}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={t("pref.filter.title")} sub={t("pref.filter.sub", { shown: vis.list.length, all: subs.all.length })}
        actions={<Toggle checked={prefs.filterOn} onChange={(v) => save({ filterOn: v })}>{t("pref.filter.on")}</Toggle>}>
        {vis.ignored ? <Notice tone="warning">{t("pref.filter.ignored")}</Notice> : null}
        {!subs.loaded ? <LoadingState /> : !subs.all.length ? (
          <EmptyState title={signedOut ? t("pref.dir.signin") : t("pref.filter.none")} />
        ) : (
          <div className={st.filter} data-off={!prefs.filterOn || undefined}>
            {groupByConnection(subs.all).map(([key, name, list]) => {
              const shown = list.filter((s) => !hidden.has(s.subscriptionId.toLowerCase())).length;
              return (
                <section key={key} className={st.group} aria-label={name}>
                  <header className={st.groupHead}>
                    <strong>{name}</strong>
                    <span className={st.sub}>{t("pref.filter.groupCount", { shown, all: list.length })}</span>
                    <span className={st.groupActions}>
                      <LinkButton onClick={() => setHidden(list.map((s) => s.subscriptionId), false)}>{t("pref.filter.all")}</LinkButton>
                      <LinkButton tone="muted" onClick={() => setHidden(list.map((s) => s.subscriptionId), true)}>{t("pref.filter.noneInGroup")}</LinkButton>
                    </span>
                  </header>
                  <ul className={st.subList}>
                    {list.map((s) => (
                      <li key={s.subscriptionId}>
                        <label className={st.check}>
                          <input type="checkbox" checked={!hidden.has(s.subscriptionId.toLowerCase())} disabled={!prefs.filterOn}
                            onChange={(e) => setHidden([s.subscriptionId], !e.target.checked)} />
                          <span className={st.main}>{s.name ?? t("pref.filter.unnamed")}</span>
                          <span className={st.mono}>…{s.subscriptionId.slice(-4)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <p className={st.hint}>{t("pref.filter.foot")}</p>
          </div>
        )}
      </Panel>

      <Panel title={t("pref.start.title")} sub={t("pref.start.sub")}>
        <div className={st.row}>
          <Select label={t("pref.start.label")} value={vis.list.some((s) => s.subscriptionId.toLowerCase() === prefs.start) ? prefs.start : ""}
            onChange={(v) => save({ start: v })}
            options={[{ value: "", label: t("pref.start.first") }, ...vis.list.map((s) => ({ value: s.subscriptionId.toLowerCase(), label: `${s.name ?? t("pref.filter.unnamed")} · …${s.subscriptionId.slice(-4)}` }))]} />
          <p className={st.hint}>{t("pref.start.hint")}</p>
        </div>
      </Panel>
    </div>
  );
}

function CloudName({ provider }: { provider: CloudProvider }) {
  const { t } = useI18n();
  return (
    <span className={st.cloud}>
      <span className={st.cloudMark} data-provider={provider} aria-hidden="true" />
      <span className={st.main}>{t(`pref.cloud.${provider}`)}</span>
      <span className={st.sub}>{t(`pref.scope.${PROVIDER_SCOPE[provider]}`)}</span>
    </span>
  );
}

/** Subscriptions by connection, in the API's order (a subscription with no connection = its own group) */
function groupByConnection(list: AzureSubscriptionOption[]): Array<[string, string, AzureSubscriptionOption[]]> {
  const m = new Map<string, [string, string, AzureSubscriptionOption[]]>();
  for (const s of list) {
    const k = s.connectionKey ?? "";
    const g = m.get(k) ?? [k, s.connectionName ?? s.connectionKey ?? "—", []];
    g[2].push(s);
    m.set(k, g);
  }
  return [...m.values()];
}

// ── 모양 ──

function AppearanceTab() {
  const { t } = useI18n();
  const { theme, density, setTheme, setDensity } = useDisplayPrefs();
  const [prefs, save] = useViewPrefs();
  return (
    <div className={st.stack}>
      <Panel title={t("pref.look.title")} sub={t("pref.look.sub")}>
        <div className={st.stack}>
          <Choices<Theme> name="theme" label={t("pref.look.theme")} value={theme} onChange={setTheme} items={[
            { id: "system", title: t("pref.look.theme.system"), hint: t("pref.look.theme.systemHint"), preview: <Mini theme="split" /> },
            { id: "light", title: t("pref.look.theme.light"), preview: <Mini theme="light" /> },
            { id: "dark", title: t("pref.look.theme.dark"), hint: t("pref.look.theme.darkHint"), preview: <Mini theme="dark" /> },
          ]} />
          <Choices<MenuMode> name="menu" label={t("pref.look.menu")} value={prefs.menu} onChange={(v) => save({ menu: v })} items={[
            { id: "auto", title: t("pref.look.menu.auto"), hint: t("pref.look.menu.autoHint"), preview: <Mini theme="light" menu="docked" /> },
            { id: "drawer", title: t("pref.look.menu.drawer"), hint: t("pref.look.menu.drawerHint"), preview: <Mini theme="light" menu="drawer" /> },
          ]} />
          <Choices<Density> name="density" label={t("pref.look.density")} value={density} onChange={setDensity} items={[
            { id: "comfortable", title: t("pref.look.density.comfortable"), hint: t("pref.look.density.comfortableHint"), preview: <Mini theme="light" rows={3} /> },
            { id: "compact", title: t("pref.look.density.compact"), hint: t("pref.look.density.compactHint"), preview: <Mini theme="light" rows={5} /> },
          ]} />
        </div>
      </Panel>
    </div>
  );
}

/** A small drawing of the page in a theme / with a menu / at a density — the cards' preview (Portal's 모양 cards) */
function Mini({ theme, menu = "docked", rows = 3 }: { theme: "light" | "dark" | "split"; menu?: "docked" | "drawer"; rows?: number }) {
  return (
    <span className={st.mini} data-theme={theme} data-menu={menu}>
      <span className={st.miniTop} />
      <span className={st.miniBody}>
        <span className={st.miniRail} />
        <span className={st.miniMain}>
          <span className={st.miniTiles}><i /><i /><i /><i /></span>
          {Array.from({ length: rows }, (_, i) => <span key={i} className={st.miniLine} />)}
        </span>
      </span>
    </span>
  );
}

// ── 언어 ──

function LanguageTab() {
  const { t, locale, setLocale } = useI18n();
  const sample = new Date(Date.UTC(2026, 10, 19, 6, 30));
  const show = (l: "ko" | "en") => `${sample.toLocaleString(dateLocale(l), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${(1234567.89).toLocaleString(dateLocale(l))}`;
  return (
    <Panel title={t("pref.lang.title")} sub={t("pref.lang.sub")}>
      <Choices<"ko" | "en"> name="lang" label={t("pref.lang.label")} value={locale as "ko" | "en"} onChange={(v) => setLocale(v)} items={[
        { id: "ko", title: languageName("ko"), hint: show("ko") },
        { id: "en", title: languageName("en"), hint: show("en") },
      ]} />
      <p className={st.hint}>{t("pref.lang.foot")}</p>
    </Panel>
  );
}
