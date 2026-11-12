"use client";

import Link from "next/link";
import { NavIcon } from "@/components/navIcons";
import { PageHeader } from "@/components/ui";
import { NAV_GROUPS } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import styles from "./home.module.css";
import { Briefing } from "./Briefing";
import { CORE_FEATURES } from "@/lib/briefing";

/** 개요 — every screen of the dashboard, grouped exactly like the menu (cards are generated from navConfig). */
export default function Home() {
  const { t } = useI18n();
  const groups = NAV_GROUPS.filter((g) => g.key !== "overview");

  return (
    <div className={styles.page}>
      <PageHeader
        actions={
          <div className={styles.actions}>
            <Link className={styles.primary} href="/architecture">{t("nav.item.architecture")}</Link>
            <Link className={styles.secondary} href="/security">{t("nav.item.securityOverview")}</Link>
            <Link className={styles.secondary} href="/health">{t("nav.item.health")}</Link>
          </div>
        }
      />
      {/* The one big thing on the first screen: what matters in this environment right now */}
      <Briefing />

      {/* What the platform is for — six questions and the screen that answers each */}
      <section className={styles.group} aria-labelledby="home-core">
        <h2 id="home-core" className={styles.groupTitle}>{t("home.core.title")}</h2>
        <div className={styles.features}>
          {CORE_FEATURES.map((f) => (
            <Link key={f.id} className={styles.feature} href={f.href}>
              <span className={styles.cardIcon}><NavIcon name={f.icon} size={20} /></span>
              <span className={styles.featureAsk}>{t(`home.feat.${f.id}.ask`)}</span>
              <span className={styles.cardBody}>{t(`home.feat.${f.id}.body`)}</span>
              <span className={styles.featureGo}>{t(`home.feat.${f.id}.go`)} →</span>
            </Link>
          ))}
        </div>
      </section>

      <h2 className={styles.allTitle}>{t("home.all.title")}</h2>
      <p className={styles.intro}>{t("home.intro")}</p>

      {groups.map((g) => (
        <section key={g.key} className={styles.group} aria-labelledby={`home-${g.key}`}>
          <h2 id={`home-${g.key}`} className={styles.groupTitle}>
            <NavIcon name={g.icon} size={16} />
            {t(g.labelKey)}
          </h2>
          <div className={styles.cards}>
            {g.items.map((it) => (
              <Link key={it.href} className={styles.card} href={it.href} title={t(it.descKey)}>
                <span className={styles.cardIcon}><NavIcon name={it.icon} size={20} /></span>
                <span className={styles.cardText}>
                  <span className={styles.cardTitle}>
                    {t(it.labelKey)}
                    {it.section && g.items.some((x) => x.section !== it.section) ? <span className={styles.cardSection}>{t(it.section)}</span> : null}
                  </span>
                  <span className={styles.cardBody}>{t(it.descKey)}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
