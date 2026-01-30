import "dotenv/config";
import cors from "cors";
import express from "express";
import { loadEnv } from "./env";
import { bearerTokenMiddleware } from "./auth";
import { registerRoutes } from "./routes";

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

registerRoutes(app, env);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${env.PORT}`);
});
