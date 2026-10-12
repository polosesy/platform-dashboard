"use client";

import Link from "next/link";
import { NavIcon } from "@/components/navIcons";
import { PageHeader } from "@/components/ui";
import { NAV_GROUPS } from "@/lib/navConfig";
import { useI18n } from "@/lib/i18n";
import styles from "./home.module.css";

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
      <p className={styles.intro}>{t("home.intro")}</p>

      {groups.map((g) => (
        <section key={g.key} className={styles.group} aria-labelledby={`home-${g.key}`}>
          <h2 id={`home-${g.key}`} className={styles.groupTitle}>
            <NavIcon name={g.icon} size={16} />
            {t(g.labelKey)}
          </h2>
          <div className={styles.cards}>
            {g.items.map((it) => (
              <Link key={it.href} className={styles.card} href={it.href}>
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
