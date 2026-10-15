/** Human-readable byte size (B / KB / MB / GB / TB, base 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let idx = 0;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  const digits = idx === 0 ? 0 : idx === 1 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[idx]}`;
}

/** Network rate in bits per second (Azure flow / NIC metrics report bits): "12.5 Mbps", "800 bps". Base 1000. */
export function formatBitsPerSec(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "-";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let v = Math.max(0, bps);
  let idx = 0;
  while (v >= 1000 && idx < units.length - 1) {
    v /= 1000;
    idx++;
  }
  const text = idx === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[idx]}`;
}
