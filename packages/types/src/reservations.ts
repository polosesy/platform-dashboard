export type ReservationUtilizationRow = {
  reservationId?: string;
  reservationOrderId?: string;
  skuName?: string;
  usedHours: number;
  reservedHours: number;
  utilizedPercentage?: number;
};

export type SubscriptionReservationUtilization = {
  subscriptionId: string;
  grain: "daily" | "monthly";
  /** null = no reserved hours in the period (no reservation — not 0 % used) */
  utilizedPercentage: number | null;
  usedHours: number;
  reservedHours: number;
  topReservations: ReservationUtilizationRow[];
};

export type ReservationUtilizationResponse = {
  generatedAt: string;
  grain: "daily" | "monthly";
  /** null = no reserved hours in the period (no reservation — not 0 % used) */
  utilizedPercentage: number | null;
  usedHours: number;
  reservedHours: number;
  subscriptions: SubscriptionReservationUtilization[];
  /** "mock" = sample numbers (anonymous only — a signed-in failure is an error response) */
  source?: "mock";
  note?: string;
};
