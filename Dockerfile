# Stage 1: Build Client
FROM node:24-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
# Requires package-lock.json from host context
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Production Server Environment
FROM node:24-alpine
WORKDIR /app

# Set NODE_ENV early to optimize npm and Node.js performance
ENV NODE_ENV=production

COPY server/package*.json ./
# Replace deprecated --only=production with modern --omit=dev
RUN npm ci --omit=dev

COPY server/ ./
COPY --from=client-build /app/client/dist ./client/dist

ENV PORT=3000
EXPOSE 3000

# Drop root privileges - standard container security requirement
USER node

CMD ["node", "server.js"]
