FROM node:22-alpine AS dependencies
WORKDIR /app

RUN corepack enable && corepack prepare yarn@1.22.22 --activate
COPY package.json yarn.lock ./
RUN sed -i 's#https://registry.npmmirror.com#https://registry.npmjs.org#g' yarn.lock
RUN --mount=type=cache,id=yarn-cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    --mount=type=secret,id=github_token,required=true \
    set -eu; \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/github_token)"; \
    export NPM_CONFIG_USERCONFIG=/tmp/github-packages.npmrc; \
    printf '%s\n' '@wlisfes:registry=https://npm.pkg.github.com' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' 'always-auth=true' > "$NPM_CONFIG_USERCONFIG"; \
    trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT; \
    schema_version="$(node -p "require('./package.json').dependencies['@wlisfes/chat-web-base-schema']")"; \
    schema_tarball="$(npm view "@wlisfes/chat-web-base-schema@${schema_version}" dist.tarball --silent)"; \
    test -n "$schema_tarball"; \
    sed -i "s|https://npm.pkg.github.com/@wlisfes/chat-web-base-schema/-/chat-web-base-schema-${schema_version}.tgz|${schema_tarball}|g" yarn.lock; \
    yarn install --frozen-lockfile --non-interactive --ignore-scripts

FROM dependencies AS builder
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN yarn build

FROM dependencies AS production-dependencies
RUN --mount=type=cache,id=yarn-cache,target=/usr/local/share/.cache/yarn,sharing=locked \
    --mount=type=secret,id=github_token,required=true \
    set -eu; \
    export NODE_AUTH_TOKEN="$(cat /run/secrets/github_token)"; \
    export NPM_CONFIG_USERCONFIG=/tmp/github-packages.npmrc; \
    printf '%s\n' '@wlisfes:registry=https://npm.pkg.github.com' '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' 'always-auth=true' > "$NPM_CONFIG_USERCONFIG"; \
    trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT; \
    yarn install --frozen-lockfile --production=true --prefer-offline --non-interactive --ignore-scripts

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production PORT=5080
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 5080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
    CMD node -e "require('http').get('http://127.0.0.1:5080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "dist/main.js"]
