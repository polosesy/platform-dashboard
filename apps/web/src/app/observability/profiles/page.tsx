"use client";

// 모니터링 › profiles — one of the monitoring views (ObservabilityView: cluster scope, time range, PageHeader = menu label)
import { ObservabilityPage } from "../ObservabilityView";

export default function Page() {
  return <ObservabilityPage view="profiles" />;
}
