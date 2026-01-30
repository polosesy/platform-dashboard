import type { Request, Response, NextFunction } from "express";

export type AuthContext = {
  bearerToken?: string;
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export function bearerTokenMiddleware(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  req.auth = { bearerToken: m?.[1] };
  next();
}
