# Stage 1: Client Build Environment
FROM node:24-alpine AS client-build
WORKDIR /app/client

# Cache dependencies layer separately
COPY client/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Invalidate cache from this point forward via Docker Build Arg in Render
ARG CACHE_BUST=1

# Copy source and execute build
COPY client/ ./
RUN npm run build

# Stage 2: Production Server Environment
FROM node:24-alpine
WORKDIR /app

# Install dumb-init to properly handle PID 1 OS signals (SIGTERM/SIGINT) in containerized Node
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Set up proper ownership before dropping root privileges
RUN chown -R node:node /app

# Drop root privileges immediately
USER node

# Cache server dependencies layer
COPY --chown=node:node server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Invalidate cache from this point forward via Docker Build Arg in Render
ARG CACHE_BUST=1

# Copy server source and pre-built client assets with correct ownership
COPY --chown=node:node server/ ./
COPY --chown=node:node --from=client-build /app/client/dist ./client/dist

# Execute via dumb-init for graceful shutdowns and zombie process prevention
CMD ["dumb-init", "node", "server.js"]
