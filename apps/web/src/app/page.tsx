import Link from "next/link";
import styles from "./home.module.css";

const features = [
  {
    href: "/architecture",
    title: "Architecture Map",
    desc: "VNET/subnet/AKS/App Gateway topology with node-level health and dependency visualization.",
    accent: "var(--accent)",
  },
  {
    href: "/live-diagram",
    title: "Live Diagram",
    desc: "Real-time topology with 2D/3D modes, D3 particle animation, fault ripple, and traffic heatmap.",
    accent: "var(--accent-2)",
  },
  {
    href: "/health",
    title: "Resource Health",
    desc: "Resource availability states with donut chart, state filters, and detailed status table.",
    accent: "#10893e",
  },
  {
    href: "/network",
    title: "Network Flow",
    desc: "Top talkers, denied flows, subnet/IP pairs and service-to-service traffic analysis.",
    accent: "var(--accent)",
  },
  {
    href: "/cost",
    title: "Cost Management",
    desc: "Monthly spend, forecasts, budget tracking with trend charts and cost breakdown.",
    accent: "var(--warning)",
  },
  {
    href: "/security",
    title: "Security",
    desc: "Defender Secure Score, active alerts by severity, control scores, and MITRE tactics.",
    accent: "var(--danger)",
  },
  {
    href: "/argocd",
    title: "ArgoCD",
    desc: "GitOps sync/health/revision status and deployment drift across environments.",
    accent: "#6b4fbb",
  },
];

export default function Home() {
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.kicker}>Unified visibility</div>
        <h1 className={styles.title}>
          Azure architecture, network flows, and delivery status.
        </h1>
        <p className={styles.subtitle}>
          Resource Graph + Monitor + Log Analytics + Defender + ArgoCD in one
          place. Explore real-time topology, health, cost, security, and
          delivery across your entire Azure estate.
        </p>

        <div className={styles.actions}>
          <Link className={styles.primary} href="/live-diagram">
            Open Live Diagram
          </Link>
          <Link className={styles.secondary} href="/architecture">
            Architecture Map
          </Link>
          <Link className={styles.secondary} href="/health">
            Resource Health
          </Link>
        </div>
      </section>

      <section className={styles.cards}>
        {features.map((f) => (
          <Link key={f.href} className={styles.card} href={f.href}>
            <div
              className={styles.cardAccent}
              style={{ background: f.accent }}
            />
            <div className={styles.cardTitle}>{f.title}</div>
            <div className={styles.cardBody}>{f.desc}</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
