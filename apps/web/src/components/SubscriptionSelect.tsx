"use client";

import type { AzureSubscriptionOption } from "@aud/types";
import { useI18n } from "@/lib/i18n";
import { Select } from "./ui";

type Props = {
  subscriptions: AzureSubscriptionOption[];
  value: string;
  onChange: (subscriptionId: string) => void;
};

/** Subscription picker used by every page — shows the display name, never the full ID. */
export function SubscriptionSelect({ subscriptions, value, onChange }: Props) {
  const { t } = useI18n();
  return (
    <Select
      label={t("common.subscription")}
      value={value}
      onChange={onChange}
      options={subscriptions.map((s) => ({
        value: s.subscriptionId,
        label: s.name && s.name !== s.subscriptionId ? s.name : `${s.subscriptionId.slice(0, 8)}…`,
      }))}
    />
  );
}
