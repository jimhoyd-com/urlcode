FROM node:26-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae
ENV NODE_ENV=production
WORKDIR /opt/urlcode
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY schemas ./schemas
COPY starters ./starters
USER node
WORKDIR /project
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/_urlcode/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/urlcode/src/cli.js"]
CMD ["serve", "--project", "/project", "--host", "0.0.0.0"]
