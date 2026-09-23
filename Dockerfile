# syntax=docker/dockerfile:1

# The onkie.dev card: a static Vite build, served by nginx on port 3000.

ARG NODE_IMAGE=node:24-bookworm-slim

# --- build ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Only the manifests, so the install layer is reused until the lockfile moves.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build

# --- runtime ----------------------------------------------------------------
FROM nginx:1.29-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 3000
