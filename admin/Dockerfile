FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node editor-entry.js ./
COPY --chown=node:node diagram-entry.js ./
COPY --chown=node:node public ./public
RUN npm run build && npm prune --omit=dev
# Use SQL Server's UID so uploaded .bak files are readable by both services.
USER 10001:10001
EXPOSE 3000
CMD ["node", "server.js"]
