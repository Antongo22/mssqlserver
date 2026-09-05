FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
