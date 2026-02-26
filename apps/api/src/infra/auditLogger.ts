type AuditEvent = {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  route?: string;
  userId?: string;
  subscriptionId?: string;
  durationMs?: number;
  detail?: string;
};

export function logAudit(event: AuditEvent): void {
  const line = JSON.stringify({ ...event, ts: event.ts || new Date().toISOString() });
  if (event.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function auditApiCall(route: string, durationMs: number, success: boolean, detail?: string): void {
  logAudit({
    ts: new Date().toISOString(),
    level: success ? "info" : "error",
    event: "api_call",
    route,
    durationMs,
    detail,
  });
}
