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
  utilizedPercentage: number;
  usedHours: number;
  reservedHours: number;
  topReservations: ReservationUtilizationRow[];
};

export type ReservationUtilizationResponse = {
  generatedAt: string;
  grain: "daily" | "monthly";
  utilizedPercentage: number;
  usedHours: number;
  reservedHours: number;
  subscriptions: SubscriptionReservationUtilization[];
  note?: string;
};
