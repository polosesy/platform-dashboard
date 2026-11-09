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
# The runtime stage only COPYs (a hardened runtime image has no shell or npm) onto a one-layer copy of the runtime
# base cleaned by deploy/docker/runtime-clean.cjs (no npm · corepack · yarn, Debian security updates, no apt) —
# scanners read every layer, so nothing deleted may sit underneath. Another runtime base: --build-arg RUNTIME_PATH.
ARG NODE_BUILD_IMAGE=node:24.22.1-bookworm-slim
ARG NODE_RUNTIME_IMAGE=node:24.22.1-bookworm-slim

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

# ── runtime-base: the Node runtime image without its package managers, OS updates applied, apt gone ──
# (deploy/docker/runtime-clean.cjs — node exec form: a hardened runtime has no shell). USER 0 only here: a hardened
# image defaults to non-root.
FROM ${NODE_RUNTIME_IMAGE} AS runtime-base
USER 0:0
COPY deploy/docker/runtime-clean.cjs /tmp/runtime-clean.cjs
RUN ["node", "/tmp/runtime-clean.cjs"]

# ── runtime: that file system as ONE layer, then files only, root-owned and read-only to the non-root user ──
# Deleting in a layer on top leaves the files in the base layer, and scanners read every layer (2026-11-04 the in-place
# delete; 2026-11-09 Defender still reported npm 11.19.1's minimatch · brace-expansion · glob · ip-address · undici ·
# postcss-selector-parser and apt 2.6.1). The copy keeps files, not the base image's settings: PATH is set here
# (RUNTIME_PATH — the official Node image's; another runtime base passes its own) and there is no entrypoint script.
FROM scratch AS runtime
ARG AUD_VERSION=dev
ARG RUNTIME_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=runtime-base / /
ENV PATH=${RUNTIME_PATH}
LABEL org.opencontainers.image.title="azure-unified-dashboard" \
      org.opencontainers.image.version="${AUD_VERSION}" \
      org.opencontainers.image.description="Azure Unified Dashboard (API + web) — read-only Azure / AKS operations dashboard"
WORKDIR /app
# The build fails here when node isn't on PATH or a package manager / apt survived (a broken image never ships)
RUN ["node", "-e", "const fs=require('fs');const left=['/usr/local/lib/node_modules','/usr/local/bin/npm','/usr/local/bin/npx','/usr/local/bin/corepack','/usr/bin/apt','/usr/bin/apt-get','/tmp/runtime-clean.cjs'].filter(p=>fs.existsSync(p));if(left.length){console.error('left: '+left.join(', '));process.exit(1)}"]
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
