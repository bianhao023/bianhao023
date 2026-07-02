# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install dev dependencies (typescript, @types/node) for the build.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The core has zero runtime dependencies; persistence adds the optional `pg` and
# `redis` drivers (installed only when DATABASE_URL/REDIS_URL are configured).
# `npm ci --omit=dev` installs prod + optional deps but skips devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as the unprivileged built-in node user.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
