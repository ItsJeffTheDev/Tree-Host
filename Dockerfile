# Tree Host in a container, for the staging site on Google Cloud Run (same project as Firebase).
# See deploy/staging/README.md. No npm packages: just Node and the source.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY staff-docs ./staff-docs
COPY minecraft-plugin/TreeHostStaff.jar ./minecraft-plugin/TreeHostStaff.jar
ENV NODE_ENV=production \
    TREEHOST_HOST=0.0.0.0 \
    TREEHOST_PORT=8080 \
    TREEHOST_DATA=/tmp/treehost \
    TREEHOST_ISOLATION=off \
    TREEHOST_TRUST_PROXY=1
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
