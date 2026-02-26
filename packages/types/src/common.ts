export type AzureSubscriptionOption = {
  subscriptionId: string;
  name?: string;
};

export type AzureSubscriptionsResponse = {
  generatedAt: string;
  subscriptions: AzureSubscriptionOption[];
  note?: string;
};
