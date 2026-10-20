# syntax=docker/dockerfile:1.7
# One image for the whole platform: the API (Express) and the web (Next.js standalone). Two processes = two
# containers of this image sharing one network namespace — on-prem Docker Compose (deploy/docker) and an AKS pod
# (deploy/kubernetes) alike: web :3000 is the only open port, the API listens on 127.0.0.1:4000 next to it.
#
#   docker build -t aud-dashboard:<tag> --build-arg AUD_VERSION=<git sha> .
#   web: (default CMD)            node /app/web/apps/web/server.js
#   api: command override         node /app/apps/api/dist/index.js
#
# Nothing environment-specific is baked in: no .env, no connections file, no sign-in IDs (the web reads AUD_WEB_*
# per request). The cluster build swaps the base images for the customer's hardened (DHI) mirror:
#   --build-arg NODE_BUILD_IMAGE=<acr>/common-resource/dhi-node:<ver>-dev --build-arg NODE_RUNTIME_IMAGE=<acr>/common-resource/dhi-node:<ver>
# The runtime stage only COPYs (a hardened runtime image has no shell or npm).
ARG NODE_BUILD_IMAGE=node:24.13.0-bookworm-slim
ARG NODE_RUNTIME_IMAGE=node:24.13.0-bookworm-slim

# ── build: install everything, compile the API, build the web as a standalone server ──
FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
RUN npm ci --no-audit --no-fund
COPY . .
# The /api rewrite target is fixed at build: the API next to the web in the same network namespace. The API's
# compiled code must not import the TS-only @aud/types package at run time (type imports are erased)
ENV NEXT_OUTPUT=standalone NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000
RUN npm run build --workspace apps/api && npm run build --workspace apps/web \
 && ! grep -rqE "['\"]@aud/types['\"]" apps/api/dist

# ── prune: the API's production dependencies only ──
FROM ${NODE_BUILD_IMAGE} AS prune
WORKDIR /prune
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
# npm hoists most packages to /prune/node_modules but nests a version it cannot hoist (zod) in
# /prune/apps/api/node_modules — both are copied; the directory always exists so the COPY never fails
RUN npm ci --omit=dev --workspace @aud/api --include-workspace-root=false --no-audit --no-fund  && mkdir -p apps/api/node_modules

# ── runtime: files only, root-owned and read-only to the non-root user ──
FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG AUD_VERSION=dev
LABEL org.opencontainers.image.title="azure-unified-dashboard" \
      org.opencontainers.image.version="${AUD_VERSION}" \
      org.opencontainers.image.description="Azure Unified Dashboard (API + web) — read-only Azure / AKS operations dashboard"
WORKDIR /app
# HOSTNAME=0.0.0.0: the Next standalone server binds to $HOSTNAME, which Kubernetes sets to the pod name
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/tmp HOSTNAME=0.0.0.0 AUD_VERSION=${AUD_VERSION}
COPY --from=prune /prune/node_modules /app/node_modules
COPY --from=prune /prune/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /src/apps/api/package.json /app/apps/api/package.json
COPY --from=build /src/apps/api/dist /app/apps/api/dist
COPY --from=build /src/apps/web/.next/standalone /app/web
COPY --from=build /src/apps/web/.next/static /app/web/apps/web/.next/static
COPY --from=build /src/apps/web/public /app/web/apps/web/public
# Numeric user so Kubernetes runAsNonRoot can verify it (Gatekeeper standard: 65532)
USER 65532:65532
EXPOSE 3000
CMD ["node", "/app/web/apps/web/server.js"]
