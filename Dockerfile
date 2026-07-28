# SPEC §10 — multi-stage build, Next `output: 'standalone'`, single image.
#
# ⚠️ VERIFY — THIS FILE HAS NEVER BEEN BUILT. Docker is not installed on the development machine
# and the smoke test was skipped by decision (2026-07-28). Treat every line below as unproven:
# in particular the non-root write access to /data and the standalone COPY paths. The
# `next build` → `.next/standalone/server.js` output it targets IS verified (exit 0, no AWS
# credentials needed). See VERIFICATION.md §1.3 for the exact commands to close this.

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` for a lockfile-exact install; pptxgenjs is pinned exactly (§1.1 findings are
# version-specific — C1/C5 were both traced to pptxgenjs 4.0.1 source).
RUN npm ci

# ── build ─────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No AWS credentials at build time by design: registries are static data, and §1.3 requires the
# app boot and serve /api/registry/* without them.
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

# Non-root. DATA_DIR must be writable by this user — mount it with matching ownership, or on
# Fargate/EFS set the access point's POSIX user to 1001.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# `standalone` ships its own minimal node_modules; static/ and public/ are not included in it.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

RUN mkdir -p /data && chown nextjs:nodejs /data
VOLUME /data
USER nextjs
EXPOSE 3000

# The standalone server, not `next start` — that would need the full next package.
CMD ["node", "server.js"]
