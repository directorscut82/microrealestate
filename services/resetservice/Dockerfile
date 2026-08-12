FROM node:20-bookworm-slim AS base

FROM base AS build
WORKDIR /usr/app
COPY package.json .
COPY .yarnrc.yml .
COPY yarn.lock .
COPY .yarn/plugins .yarn/plugins
COPY .yarn/releases .yarn/releases
COPY types types
COPY services/common services/common
COPY services/resetservice services/resetservice
# Per-service cache id. All 9 image jobs run in PARALLEL from one matrix and every
# Dockerfile used `id=node_modules`, so they raced on a single shared cache mount:
# a partially-populated cache makes yarn report "must be built because the last one
# failed", and in --production mode that is fatal. Measured 2026-08-12: the same
# commit failed on canvas for api, then on bcrypt for pdfgenerator on the re-run —
# a different service each time, which is the signature of contention rather than a
# code defect.
RUN --mount=type=cache,id=node_modules-resetservice,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/resetservice && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/resetservice run build

FROM base AS deps
# Native modules (bcrypt via @microrealestate/common, canvas, aws-sdk, puppeteer)
# compile here. This stage previously had NO toolchain and only ever succeeded on a
# warm yarn cache: any change to services/common busts the Docker layer cache for
# this COPY, `yarn workspaces focus --production` then actually runs, node-gyp has
# no compiler, and the build fails on a package the service does not even use
# directly. Measured 2026-08-12 — CI went red on bcrypt for pdfgenerator and on
# canvas for api, on a commit that touched no manifest and no lockfile.
RUN apk --no-cache add build-base python3
WORKDIR /usr/app
COPY --from=build /usr/app/package.json .
COPY --from=build /usr/app/.yarnrc.yml .
COPY --from=build /usr/app/yarn.lock .
COPY --from=build /usr/app/.yarn/plugins .yarn/plugins
COPY --from=build /usr/app/.yarn/releases .yarn/releases
COPY --from=build /usr/app/types/package.json types/package.json
COPY --from=build /usr/app/services/common/package.json ./services/common/package.json
COPY --from=build /usr/app/services/resetservice/package.json ./services/resetservice/package.json
COPY --from=build /usr/app/services/common/dist ./services/common/dist
COPY --from=build /usr/app/services/resetservice/dist ./services/resetservice/dist
RUN --mount=type=cache,id=node_modules-resetservice,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus --production @microrealestate/resetservice

FROM gcr.io/distroless/nodejs20-debian12
ENV NODE_ENV production
WORKDIR /usr/app
COPY --from=deps /usr/app ./

USER 1000
CMD ["services/resetservice/dist/index.js"]
