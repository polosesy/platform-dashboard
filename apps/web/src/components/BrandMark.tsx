// The platform's mark — the same drawing as the browser icons (scripts/gen-icons.mjs → app/icon.svg, favicon.ico,
// apple-icon.png; apps/api/test/brandIcons.test.ts checks the points agree). A tile in the platform's two colours and one
// line through four nodes: connected resources (the diagrams) and a signal over time (the monitoring).

import styles from "./BrandMark.module.css";

/** The line's nodes in a 32 × 32 box */
export const MARK_POINTS = "7,22 13,14 19,19 25,10";

export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  const nodes = MARK_POINTS.split(" ").map((p) => p.split(",").map(Number) as [number, number]);
  return (
    <span className={`${styles.mark} ${size === "sm" ? styles.sm : ""}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" className={styles.glyph} focusable="false">
        <polyline points={MARK_POINTS} />
        {nodes.map(([x, y]) => <circle key={`${x},${y}`} cx={x} cy={y} r={2.6} />)}
      </svg>
    </span>
  );
}
