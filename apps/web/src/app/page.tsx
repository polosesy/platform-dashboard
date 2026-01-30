import Link from "next/link";
import styles from "./home.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.kicker}>Unified visibility</div>
        <h1 className={styles.title}>Azure architecture, network flows, and delivery status.</h1>
        <p className={styles.subtitle}>
          Resource Graph + Monitor + Log Analytics + ArgoCD in one place. Start with the architecture map and drill into
          health + key metrics.
        </p>

        <div className={styles.actions}>
          <Link className={styles.primary} href="/architecture">
            Open Architecture Map
          </Link>
          <Link className={styles.secondary} href="/argocd">
            View ArgoCD
          </Link>
        </div>
      </section>

      <section className={styles.cards}>
        <Link className={styles.card} href="/architecture">
          <div className={styles.cardTitle}>Architecture Map</div>
          <div className={styles.cardBody}>VNET/subnet/AKS/app gateway and dependencies with node-level health.</div>
        </Link>
        <Link className={styles.card} href="/network">
          <div className={styles.cardTitle}>Network Flow</div>
          <div className={styles.cardBody}>Top talkers, denies, and service-to-service paths (MVP placeholder).</div>
        </Link>
        <Link className={styles.card} href="/argocd">
          <div className={styles.cardTitle}>ArgoCD</div>
          <div className={styles.cardBody}>Sync/health/revision and deployment drift across environments.</div>
        </Link>
      </section>
    </div>
  );
}
