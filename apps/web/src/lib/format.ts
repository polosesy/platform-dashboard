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
