"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";

export type Locale = "ko" | "en";

type Translations = Record<string, Record<Locale, string>>;

const T: Translations = {
  // ── Live Diagram Page ──
  "live.title": { ko: "라이브 아키텍처", en: "Live Architecture" },
  "live.loading": { ko: "로딩중...", en: "Loading..." },
  "live.noDiagram": { ko: "다이어그램 없음", en: "No diagram" },
  "live.updated": { ko: "업데이트", en: "Updated" },
  "live.connected": { ko: "연결됨", en: "Live" },
  "live.disconnected": { ko: "연결 끊김", en: "Disconnected" },
  "live.polling": { ko: "폴링 (30초)", en: "Polling (30s)" },
  "live.sse": { ko: "SSE 스트림", en: "SSE Stream" },
  "live.refresh": { ko: "새로고침", en: "Refresh" },
  "live.generateFromAzure": { ko: "Azure에서 생성", en: "Generate from Azure" },
  "live.generating": { ko: "생성 중...", en: "Generating..." },
  "live.subscription": { ko: "구독", en: "Subscription" },
  "live.networkFlow": { ko: "네트워크 플로우", en: "Network Flow" },
  "live.particles": { ko: "파티클", en: "Particles" },
  "live.faultRipple": { ko: "장애 파급", en: "Fault Ripple" },
  "live.heatmap": { ko: "히트맵", en: "Heatmap" },
  "live.timeline": { ko: "타임라인", en: "Timeline" },
  "live.nodes": { ko: "노드", en: "Nodes" },
  "live.edges": { ko: "엣지", en: "Edges" },
  "live.bindings": { ko: "바인딩", en: "Bindings" },
  "live.alerts": { ko: "알림", en: "Alerts" },
  "live.faults": { ko: "장애", en: "Faults" },
  "live.loading3d": { ko: "3D 로딩 중...", en: "Loading 3D..." },

  // ── Visualization Modes ──
  "viz.2d": { ko: "2D 기본", en: "2D Standard" },
  "viz.2d-animated": { ko: "2D 애니메이션", en: "2D Animated" },
  "viz.3d": { ko: "3D 토폴로지", en: "3D Topology" },

  // ── Alert Sidebar ──
  "alert.title": { ko: "활성 알림", en: "Active Alerts" },
  "alert.empty": { ko: "활성 알림 없음", en: "No active alerts" },
  "alert.causes": { ko: "원인:", en: "Causes:" },
  "alert.affects": { ko: "영향:", en: "Affects:" },

  // ── Fault Timeline ──
  "fault.title": { ko: "장애 타임라인", en: "Fault Timeline" },
  "fault.empty": { ko: "활성 장애 없음", en: "No active faults" },

  // ── Resource Detail Panel ──
  "detail.kind": { ko: "유형", en: "Type" },
  "detail.location": { ko: "위치", en: "Location" },
  "detail.resourceGroup": { ko: "리소스 그룹", en: "Resource Group" },
  "detail.endpoint": { ko: "엔드포인트", en: "Endpoint" },
  "detail.azureId": { ko: "Azure Resource ID", en: "Azure Resource ID" },
  "detail.tags": { ko: "태그", en: "Tags" },
  "detail.metrics": { ko: "메트릭", en: "Metrics" },
  "detail.alerts": { ko: "알림", en: "Alerts" },
  "detail.connections": { ko: "연결", en: "Connections" },
  "detail.noAlerts": { ko: "활성 알림 없음", en: "No active alerts" },
  "detail.inbound": { ko: "인바운드", en: "Inbound" },
  "detail.outbound": { ko: "아웃바운드", en: "Outbound" },
  "detail.health": { ko: "상태", en: "Health" },
  "detail.noData": { ko: "데이터 없음", en: "No data" },
  "detail.noMetrics": { ko: "메트릭 없음", en: "No metrics" },
  "detail.essentials": { ko: "필수 정보", en: "Essentials" },
  "detail.status": { ko: "상태", en: "Status" },
  "detail.alertCauses": { ko: "원인 후보", en: "Root Causes" },
  "detail.alertAffects": { ko: "영향", en: "Affects" },
  "detail.alertNodes": { ko: "노드", en: "nodes" },
  "detail.alertEdges": { ko: "엣지", en: "edges" },
  "detail.alertRules": { ko: "경고 규칙", en: "Alert Rules" },
  "detail.disabled": { ko: "비활성", en: "Disabled" },

  // ── Tenant / Subscription Selector ──
  "live.tenant": { ko: "테넌트", en: "Tenant" },
  "live.selectTenant": { ko: "테넌트 선택", en: "Select Tenant" },
  "live.region": { ko: "리전", en: "Region" },
  "live.vnet": { ko: "VNet", en: "VNet" },
  "live.allRegions": { ko: "전체 리전", en: "All Regions" },
  "live.allVnets": { ko: "전체 VNet", en: "All VNets" },

  // ── Common ──
  "common.language": { ko: "한국어", en: "English" },
  "common.overview": { ko: "개요", en: "Overview" },
  "common.architecture": { ko: "아키텍처 맵", en: "Architecture Map" },
  "common.liveDiagram": { ko: "라이브 다이어그램", en: "Live Diagram" },
  "common.cost": { ko: "비용 분석", en: "Cost Analysis" },
  "common.security": { ko: "보안", en: "Security" },
  "common.health": { ko: "상태", en: "Health" },
  "common.network": { ko: "네트워크", en: "Network" },
  "common.argocd": { ko: "ArgoCD", en: "ArgoCD" },

  // ── Navigation / Sidebar ──
  "nav.dashboard": { ko: "대시보드", en: "Dashboard" },
  "nav.visualization": { ko: "시각화", en: "Visualization" },
  "nav.monitoring": { ko: "모니터링", en: "Monitoring" },
  "nav.operations": { ko: "운영", en: "Operations" },
  "nav.settings": { ko: "설정", en: "Settings" },
  "nav.resourceHealth": { ko: "리소스 상태", en: "Resource Health" },
  "nav.networkFlow": { ko: "네트워크 흐름", en: "Network Flow" },
  "nav.costManagement": { ko: "비용 관리", en: "Cost Management" },

  // ── Settings ──
  "settings.language": { ko: "언어", en: "Language" },
  "settings.korean": { ko: "한국어", en: "Korean" },
  "settings.english": { ko: "영어", en: "English" },

  // ── Health Page ──
  "health.title": { ko: "서비스 상태", en: "Service Health" },
  "health.tabGlobal": { ko: "글로벌 상태", en: "Global Status" },
  "health.tabInstance": { ko: "인스턴스 상태", en: "Instance Health" },
  "health.tabService": { ko: "서비스 이벤트", en: "Service Events" },
  "health.generatedAt": { ko: "갱신", en: "Updated" },
  "health.loading": { ko: "로딩 중...", en: "Loading..." },
  "health.error": { ko: "로드 실패", en: "Failed to load" },

  // Tab 1 — Global Status
  "health.allOperational": { ko: "모든 Azure 서비스가 정상 운영 중입니다", en: "All Azure services are operating normally" },
  "health.allOperationalSub": { ko: "현재 활성 인시던트가 없습니다", en: "There are no active incidents at this time" },
  "health.activeIncidents": { ko: "활성 인시던트", en: "Active Incidents" },
  "health.azureStatusLink": { ko: "Azure 공식 상태 페이지", en: "Azure Official Status Page" },
  "health.incident.Active": { ko: "활성", en: "Active" },
  "health.incident.Investigating": { ko: "조사 중", en: "Investigating" },
  "health.incident.Mitigated": { ko: "완화됨", en: "Mitigated" },
  "health.incident.Resolved": { ko: "해결됨", en: "Resolved" },
  "health.affectedRegions": { ko: "영향 리전", en: "Affected Regions" },
  "health.affectedServices": { ko: "영향 서비스", en: "Affected Services" },
  "health.viewDetails": { ko: "상세 보기", en: "View Details" },

  // Tab 2 — Instance Health
  "health.resources": { ko: "리소스", en: "Resources" },
  "health.healthDistribution": { ko: "상태 분포", en: "Health Distribution" },
  "health.filterAll": { ko: "전체", en: "All" },

  // Tab 3 — Service Events
  "health.noEvents": { ko: "활성 이벤트 없음", en: "No active events" },
  "health.impactStart": { ko: "영향 시작", en: "Impact Start" },
  "health.impactEnd": { ko: "영향 종료", en: "Impact End" },
  "health.lastUpdate": { ko: "최종 업데이트", en: "Last Update" },
  "health.eventType.ServiceIssue": { ko: "서비스 문제", en: "Service Issue" },
  "health.eventType.PlannedMaintenance": { ko: "계획된 유지 보수", en: "Planned Maintenance" },
  "health.eventType.HealthAdvisory": { ko: "상태 권고", en: "Health Advisory" },
  "health.eventType.SecurityAdvisory": { ko: "보안 권고", en: "Security Advisory" },
};

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: "ko",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  // Always start with "ko" to avoid SSR/client hydration mismatch
  const [locale, setLocaleState] = useState<Locale>("ko");

  // Sync from localStorage after hydration
  useEffect(() => {
    const saved = localStorage.getItem("aud-locale") as Locale | null;
    if (saved && (saved === "ko" || saved === "en")) {
      setLocaleState(saved);
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("aud-locale", l);
  }, []);

  const t = useCallback(
    (key: string): string => {
      return T[key]?.[locale] ?? key;
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
