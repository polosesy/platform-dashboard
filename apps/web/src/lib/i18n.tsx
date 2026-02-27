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
