# The dashboard, as a container.
#
# Three stages so the thing that ships is only a Node runtime and the traced output of
# `next build` — no compiler, no dev dependencies, no source. Built by GitHub Actions on
# every push to main and pulled by the VPS; see .github/workflows/deploy.yml.

# ---------------------------------------------------------------------------
# deps — install exactly what package-lock.json pins.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
# Next's SWC binary is glibc-linked and needs the compatibility shim on musl.
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json ./
# Needs network: the `xlsx` dependency is a cdn.sheetjs.com tarball URL rather than a
# registry name, so an offline build cannot resolve it.
RUN npm ci

# ---------------------------------------------------------------------------
# builder — compile the app.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# These two must be present *at build time*, not just at run time: Next inlines every
# NEXT_PUBLIC_ variable into the browser bundle during `next build`, so a value supplied
# only to `docker run` arrives too late and the client-side Supabase client is
# constructed with `undefined`. Both are public by design — the URL and the publishable
# key are already visible to anyone who loads the page.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

# The service-role key is deliberately absent here. It must never enter a layer; the
# container reads it from the host's env file at run time.

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Also needs network: app/layout.tsx pulls Archivo and IBM Plex Mono through
# next/font/google, which fetches and self-hosts them during the build.
RUN npm run build

# ---------------------------------------------------------------------------
# runner — what actually ships.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Bind all interfaces, not loopback: Traefik reaches this container over the Docker
# network, so a server listening only on 127.0.0.1 would look like a dead backend.
ENV HOSTNAME=0.0.0.0

# `node` (uid 1000) ships with the base image. Running as root would gain nothing here
# and the bind-mounted cache directory on the host is chowned to 1000 to match.
USER node

# standalone carries server.js and the traced subset of node_modules...
COPY --from=builder --chown=node:node /app/.next/standalone ./
# ...but not the static assets, which have to be placed by hand. This repo has no
# public/ directory, so there is nothing else to copy.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

EXPOSE 3000

# Compose supplies a healthcheck against /login; keeping it there rather than here means
# it can change without a rebuild.
CMD ["node", "server.js"]
