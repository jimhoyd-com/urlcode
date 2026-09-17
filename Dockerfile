FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae AS build
WORKDIR /opt/urlcode
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY data ./data
RUN npm run build && npm prune --omit=dev --ignore-scripts && npm cache clean --force

# Same digest as the build stage; release.yml reads the pin from the first line.
FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
ENV NODE_ENV=production
WORKDIR /opt/urlcode
COPY --from=build /opt/urlcode/node_modules ./node_modules
COPY --from=build /opt/urlcode/dist ./dist
COPY package.json ./
COPY schemas ./schemas
COPY data ./data
COPY starters ./starters
USER node
WORKDIR /project
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/_urlcode/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/urlcode/dist/cli.js"]
CMD ["serve", "--project", "/project", "--host", "0.0.0.0"]
