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
# Cache id is per-service: 9 image jobs build in parallel from one matrix and a
# shared mutable cache mount is not something to rely on. Hardening, not the fix
# for the 2026-08-12 red builds — that was the missing compiler above.
RUN --mount=type=cache,id=node_modules-api,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/api && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/api run transpile:service && \
    cp -r services/api/src/locales services/api/dist/locales

FROM base AS deps
# bcrypt has no prebuilt binary for this image, so node-gyp compiles it here, and
# these base images ship no compiler. Needed in every stage that installs.
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
