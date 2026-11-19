"use client";

// 모니터링 › 애플리케이션 (APM) › slo — one APM view (ObservabilityView + SloTab, the view from the route)
import { ObservabilityPage } from "../../ObservabilityView";

export default function Page() {
  return <ObservabilityPage view="services" apm="slo" />;
}
