FROM node:20.17-alpine3.20 AS base

FROM base AS build
RUN apk --no-cache add build-base python3
RUN corepack enable && \
    corepack prepare yarn@3.3.0 --activate
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD 1
WORKDIR /usr/app
COPY package.json .
COPY .yarnrc.yml .
COPY yarn.lock .
COPY .yarn/plugins .yarn/plugins
COPY .yarn/releases .yarn/releases
COPY types types
COPY services/common services/common
COPY services/pdfgenerator services/pdfgenerator
# Per-service cache id. All 9 image jobs run in PARALLEL from one matrix and every
# Dockerfile used `id=node_modules`, so they raced on a single shared cache mount:
# a partially-populated cache makes yarn report "must be built because the last one
# failed", and in --production mode that is fatal. Measured 2026-08-12: the same
# commit failed on canvas for api, then on bcrypt for pdfgenerator on the re-run —
# a different service each time, which is the signature of contention rather than a
# code defect.
RUN --mount=type=cache,id=node_modules-pdfgenerator,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus @microrealestate/pdfgenerator && \
    yarn workspace @microrealestate/types run build && \
    yarn workspace @microrealestate/common run build && \
    yarn workspace @microrealestate/pdfgenerator run transpile:service

FROM base AS deps
# ALPINE ONLY. Native modules (bcrypt arrives via @microrealestate/common, plus
# canvas/aws-sdk/puppeteer) publish prebuilt binaries for glibc but not for musl, so
# on Alpine they must COMPILE — and this stage installed no toolchain, only the
# `build` stage did. It therefore succeeded solely on a warm yarn cache: any change
# to services/common busts this stage's layer cache, `yarn workspaces focus
# --production` actually runs, node-gyp finds no compiler, and the build dies on a
# package the service never calls. Measured 2026-08-12 (CI red on canvas for api,
# then bcrypt for pdfgenerator).
# The five bookworm-slim services need nothing here: glibc prebuilds resolve, which
# is why their build stages install no toolchain either. Adding `apk` to them broke
# the emailer image outright (`apk: not found`).
RUN apk --no-cache add build-base python3
WORKDIR /usr/app
COPY --from=build /usr/app/package.json .
COPY --from=build /usr/app/.yarnrc.yml .
COPY --from=build /usr/app/yarn.lock .
COPY --from=build /usr/app/.yarn/plugins .yarn/plugins
COPY --from=build /usr/app/.yarn/releases .yarn/releases
COPY --from=build /usr/app/types/package.json types/package.json
COPY --from=build /usr/app/services/common/package.json ./services/common/package.json
COPY --from=build /usr/app/services/pdfgenerator/package.json ./services/pdfgenerator/package.json
COPY --from=build /usr/app/services/common/dist ./services/common/dist
RUN --mount=type=cache,id=node_modules-pdfgenerator,target=/root/.yarn YARN_CACHE_FOLDER=/root/.yarn \
    yarn workspaces focus --production @microrealestate/pdfgenerator

FROM base
RUN apk upgrade --no-cache --available \
    && apk add --no-cache \
      chromium-swiftshader \
      ttf-freefont \
      font-noto-emoji \
      tini \
    && apk add --no-cache \
      --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community \
      font-wqy-zenhei
ENV NODE_ENV production
ENV CHROMIUM_BIN /usr/bin/chromium-browser
WORKDIR /usr/app
COPY --from=deps /usr/app ./
COPY --from=build /usr/app/services/pdfgenerator/dist ./services/pdfgenerator/dist
COPY services/pdfgenerator/data ./services/pdfgenerator/data
COPY services/pdfgenerator/templates ./services/pdfgenerator/templates
# prepare temp directories (note: /tmp, ./services/pdfgenerator/tmp,
# ./services/pdfgenerator/pdf_documents, ./services/pdfgenerator/uploads
# are mounted as tmpfs at runtime — see docker-compose.microservices.base.yml)
RUN mkdir -p ./services/pdfgenerator/tmp \
    && mkdir -p ./services/pdfgenerator/pdf_documents \
    && mkdir -p ./services/pdfgenerator/uploads

RUN chown -R 1000 ./services/pdfgenerator/data \
    && chown -R 1000 ./services/pdfgenerator/templates \
    && chown -R 1000 ./services/pdfgenerator/tmp \
    && chown -R 1000 ./services/pdfgenerator/pdf_documents \
    && chown -R 1000 ./services/pdfgenerator/uploads

USER 1000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/pdfgenerator/dist/index.js"]
