import { config as dotenvConfig } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from monorepo root (cwd is apps/api/ in workspace mode)
const _here = dirname(fileURLToPath(import.meta.url)); // → apps/api/src
dotenvConfig({ path: resolve(_here, "../../../.env") });
dotenvConfig(); // Also try local apps/api/.env if present

import cors from "cors";
import express from "express";
import { loadEnv } from "./env";
import { bearerTokenMiddleware } from "./auth";
import { registerAllRoutes } from "./routes/index";

const env = loadEnv(process.env);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true
  })
);
app.use(bearerTokenMiddleware);

registerAllRoutes(app, env);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${env.PORT}`);
});
