export type AzureSubscriptionOption = {
  subscriptionId: string;
  name?: string;
};

export type AzureSubscriptionsResponse = {
  generatedAt: string;
  subscriptions: AzureSubscriptionOption[];
  note?: string;
};

export type AzureTenantOption = {
  tenantId: string;
  displayName?: string;
};

export type AzureTenantsResponse = {
  generatedAt: string;
  tenants: AzureTenantOption[];
  note?: string;
};
