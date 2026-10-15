export type AzureSubscriptionOption = {
  subscriptionId: string;
  name?: string;
  /** Azure connection this subscription belongs to (several connections → the selector groups by it) */
  connectionKey?: string;
  connectionName?: string;
};

export type AzureSubscriptionsResponse = {
  generatedAt: string;
  subscriptions: AzureSubscriptionOption[];
  note?: string;
};

