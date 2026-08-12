FROM node:20.17-alpine3.20 AS base

FROM base AS build
RUN apk --no-cache add build-base python3
RUN corepack enable && \
    corepack prepare yarn@3.3.0 --activate
WORKDIR /usr/app
COPY package.json .
COPY .yarnrc.yml .
COPY yarn.lock .
COPY .yarn/plugins .yarn/plugins
COPY .yarn/releases .yarn/releases
COPY types types
COPY services/common services/common
COPY services/api services/api
# Per-service cache id. All 9 image jobs run in PARALLEL from one matrix and every
# Dockerfile used `id=node_modules`, so they raced on a single shared cache mount:
# a partially-populated cache makes yarn report "must be built because the last one
# failed", and in --production mode that is fatal. Measured 2026-08-12: the same
# commit failed on canvas for api, then on bcrypt for pdfgenerator on the re-run —
# a different service each time, which is the signature of contention rather than a
# code defect.
RUN --mount=type=cache,id=node_modules-api,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/api && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/api run transpile:service && \
    cp -r services/api/src/locales services/api/dist/locales

FROM base AS deps
# ALPINE ONLY. Native modules (bcrypt arrives via @microrealestate/common, plus
# canvas/aws-sdk/puppeteer) publish prebuilt binaries for glibc but not for musl, so
# on Alpine they must COMPILE — and this stage installed no toolchain, only the
# `build` stage did. It therefore succeeded solely on a warm yarn cache: any change
# to services/common busts this stage's layer cache, `yarn workspaces focus
# --production` actually runs, node-gyp finds no compiler, and the build dies on a
# package the service never calls. Measured 2026-08-12 (CI red on canvas for api,
# then bcrypt for pdfgenerator).
# The five bookworm-slim services need the SAME fix with apt-get, not apk — I first
# assumed they had glibc prebuilds and skipped them, and tenantapi then failed on
# bcrypt for exactly this reason.
RUN apk --no-cache add build-base python3
WORKDIR /usr/app
COPY --from=build /usr/app/package.json .
COPY --from=build /usr/app/.yarnrc.yml .
COPY --from=build /usr/app/yarn.lock .
COPY --from=build /usr/app/.yarn/plugins .yarn/plugins
COPY --from=build /usr/app/.yarn/releases .yarn/releases
COPY --from=build /usr/app/types/package.json types/package.json
COPY --from=build /usr/app/services/common/package.json ./services/common/package.json
COPY --from=build /usr/app/services/api/package.json ./services/api/package.json
COPY --from=build /usr/app/services/common/dist ./services/common/dist
RUN --mount=type=cache,id=node_modules-api,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus --production @microrealestate/api

FROM base
ENV NODE_ENV production
RUN apk --no-cache add mongodb-tools tini
WORKDIR /usr/app
COPY --from=deps /usr/app ./
COPY --from=build /usr/app/services/api/dist ./services/api/dist
COPY services/api/scripts ./services/api/scripts
# OCR inference models — read at runtime by dist/managers/billparser/ocr.js
# (resolves ../../../models = services/api/models). Without this the bill-image
# OCR path ENOENTs in production. ~18MB static weights, not secrets.
COPY services/api/models ./services/api/models

USER 1000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/api/dist/index.js"]
