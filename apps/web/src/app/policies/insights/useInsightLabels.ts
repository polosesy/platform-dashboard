"use client";

import { useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { insightLabels } from "./model";

/** Insights labels in the current language (rebuilt when the locale changes). */
export function useInsightLabels() {
  const { t } = useI18n();
  return useMemo(() => insightLabels(t), [t]);
}
