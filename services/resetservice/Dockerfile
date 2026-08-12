FROM node:20-bookworm-slim AS base

FROM base AS build
# bcrypt has no prebuilt binary for this image, so node-gyp compiles it here, and
# these base images ship no compiler. Needed in every stage that installs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/app
COPY package.json .
COPY .yarnrc.yml .
COPY yarn.lock .
COPY .yarn/plugins .yarn/plugins
COPY .yarn/releases .yarn/releases
COPY types types
COPY services/common services/common
COPY services/resetservice services/resetservice
# Cache id is per-service: 9 image jobs build in parallel from one matrix and a
# shared mutable cache mount is not something to rely on. Hardening, not the fix
# for the 2026-08-12 red builds — that was the missing compiler above.
RUN --mount=type=cache,id=node_modules-resetservice,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/resetservice && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/resetservice run build

FROM base AS deps
# bcrypt has no prebuilt binary for this image, so node-gyp compiles it here, and
# these base images ship no compiler. Needed in every stage that installs.
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
