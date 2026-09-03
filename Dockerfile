# Stage 1: Build Client
FROM node:24-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
# Uses npm ci if package-lock.json exists, otherwise falls back to npm install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY client/ ./
RUN npm run build

# Stage 2: Production Server Environment
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server/ ./
COPY --from=client-build /app/client/dist ./client/dist

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server.js"]