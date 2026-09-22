FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS dependencies
# Node 26 is Current, not LTS until October 2026; pinned deliberately to track
# the newest supported runtime ahead of that switch (see docs/OPERATIONS.md).
# Dependabot (.github/dependabot.yml, docker ecosystem scoped to this
# directory) proposes digest updates within the 26-bookworm-slim tag.
WORKDIR /opt/urlcode
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY packages/core/src ./packages/core/src
COPY scripts ./scripts
COPY data ./data
RUN npm run build && npm prune --omit=dev --ignore-scripts && npm cache clean --force

# Same digest as the build stage; release.yml reads the pin from the first line.
FROM node:26-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212
ENV NODE_ENV=production
WORKDIR /opt/urlcode
COPY --from=build /opt/urlcode/node_modules ./node_modules
# The full CLI image supports build-typescript. npm consumers opt into this
# compiler separately, while the image carries the exact toolchain built above.
COPY --from=dependencies /opt/urlcode/node_modules/typescript ./node_modules/typescript
COPY --from=build /opt/urlcode/dist ./dist
COPY package.json ./
COPY schemas ./schemas
COPY data ./data
COPY starters ./starters
COPY recipes ./recipes
USER node
WORKDIR /project
# PORT follows the CLI's own convention (`urlcode serve` reads it when
# --port is not given): set it once here and both the default CMD and the
# HEALTHCHECK stay correct for an operator who overrides it with `-e PORT=`.
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/_urlcode/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/urlcode/dist/cli.js"]
CMD ["serve", "--project", "/project", "--host", "0.0.0.0"]
