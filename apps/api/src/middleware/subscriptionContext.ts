import type { Request, Response, NextFunction } from "express";
import type { Env } from "../env";

export type SubscriptionContext = {
  all: string[];
  selected: string | null;
};

declare global {
  namespace Express {
    interface Request {
      subscriptionContext?: SubscriptionContext;
    }
  }
}

export function subscriptionContextMiddleware(env: Env) {
  const allowList = (env.AZURE_SUBSCRIPTION_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return (req: Request, _res: Response, next: NextFunction) => {
    const qSub = typeof req.query.subscriptionId === "string" ? req.query.subscriptionId : null;
    const selected = qSub && allowList.includes(qSub) ? qSub : null;
    req.subscriptionContext = { all: allowList, selected };
    next();
  };
}
