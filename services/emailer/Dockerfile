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
COPY services/emailer services/emailer
# Per-service cache id. All 9 image jobs run in PARALLEL from one matrix and every
# Dockerfile used `id=node_modules`, so they raced on a single shared cache mount:
# a partially-populated cache makes yarn report "must be built because the last one
# failed", and in --production mode that is fatal. Measured 2026-08-12: the same
# commit failed on canvas for api, then on bcrypt for pdfgenerator on the re-run —
# a different service each time, which is the signature of contention rather than a
# code defect.
RUN --mount=type=cache,id=node_modules-emailer,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/emailer && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/emailer run build

FROM base AS deps
# bcrypt (pulled in via @microrealestate/common, even by services that never call
# it) has NO prebuilt binary that resolves here, so node-gyp compiles it — and
# bookworm-slim ships no compiler and no python3. This stage therefore only ever
# succeeded on a warm Docker layer cache: any change to services/common busts the
# COPY above, `yarn workspaces focus --production` actually runs, and the build dies.
# Measured 2026-08-12 across three CI runs, on a commit that changed no manifest and
# no lockfile: canvas for api, then bcrypt for pdfgenerator, then bcrypt for
# tenantapi. `--production` makes a failed build script fatal, which is why the
# non-production `build` stage above tolerates the same failure.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/app
COPY --from=build /usr/app/package.json .
COPY --from=build /usr/app/.yarnrc.yml .
COPY --from=build /usr/app/yarn.lock .
COPY --from=build /usr/app/.yarn/plugins .yarn/plugins
COPY --from=build /usr/app/.yarn/releases .yarn/releases
COPY --from=build /usr/app/types/package.json types/package.json
COPY --from=build /usr/app/services/common/package.json ./services/common/package.json
COPY --from=build /usr/app/services/emailer/package.json ./services/emailer/package.json
COPY --from=build /usr/app/services/common/dist ./services/common/dist
COPY --from=build /usr/app/services/emailer/dist ./services/emailer/dist
RUN --mount=type=cache,id=node_modules-emailer,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus --production @microrealestate/emailer
# prepare temp directory
RUN mkdir -p ./services/emailer/tmp
RUN chown -R 1000 ./services/emailer/tmp 

FROM gcr.io/distroless/nodejs20-debian12
ENV NODE_ENV production
WORKDIR /usr/app
COPY --from=deps /usr/app ./

USER 1000
CMD ["services/emailer/dist/index.js"]
