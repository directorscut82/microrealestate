FROM node:20-bookworm-slim AS base

FROM base AS deps
WORKDIR /usr/app
COPY package.json .
COPY .yarnrc.yml .
COPY yarn.lock .
COPY .yarn/plugins .yarn/plugins
COPY .yarn/releases .yarn/releases
COPY types/package.json types/package.json
COPY webapps/tenant/package.json webapps/tenant/package.json
# Per-service cache id. All 9 image jobs run in PARALLEL from one matrix and every
# Dockerfile used `id=node_modules`, so they raced on a single shared cache mount:
# a partially-populated cache makes yarn report "must be built because the last one
# failed", and in --production mode that is fatal. Measured 2026-08-12: the same
# commit failed on canvas for api, then on bcrypt for pdfgenerator on the re-run —
# a different service each time, which is the signature of contention rather than a
# code defect.
RUN --mount=type=cache,id=node_modules-tenant,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/tenant

FROM base AS build
# TOOLCHAIN: these images do not pull bcrypt (they depend on commonui/types, not
# common), but the per-service cache ids added alongside this cold-start every
# cache once, and a cold install may have to compile a native dev dependency
# (canvas, sharp). bookworm-slim has no compiler. Cheap insurance in an
# intermediate stage; the runtime image copies artifacts only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/app
ENV BASE_PATH=/__MRE_BASE_PATH__
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /usr/app ./
COPY types types
COPY webapps/commonui/scripts webapps/commonui/scripts
COPY webapps/tenant/.eslintrc.json webapps/tenant
COPY webapps/tenant/components.json webapps/tenant
COPY webapps/tenant/next.config.js webapps/tenant
COPY webapps/tenant/package.json webapps/tenant
COPY webapps/tenant/postcss.config.js webapps/tenant
COPY webapps/tenant/tailwind.config.ts webapps/tenant
COPY webapps/tenant/tsconfig.json webapps/tenant
COPY webapps/tenant/locales webapps/tenant/locales
COPY webapps/tenant/public webapps/tenant/public
COPY webapps/tenant/src webapps/tenant/src
RUN yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/tenant run build
# following lines needed to be able to run webapps/commonui/scripts at container runtime
RUN chown -R 1000 /usr/app/webapps/tenant/.next && \
    chown -R 1000 /usr/app/webapps/tenant/public

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /usr/app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /usr/app/webapps/tenant/public ./public
COPY --from=build /usr/app/webapps/tenant/.next/standalone/node_modules ./node_modules
COPY --from=build /usr/app/webapps/tenant/.next/standalone/webapps/tenant ./
COPY --from=build /usr/app/webapps/tenant/.next/static ./.next/static
COPY --from=build /usr/app/webapps/commonui/scripts/replacebasepath.js ./
COPY --from=build /usr/app/webapps/commonui/scripts/runner.js ./

USER 1000
CMD ["runner.js"]
