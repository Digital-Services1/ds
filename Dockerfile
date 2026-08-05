FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DASHBOARD_STORAGE_DIR=/tmp/photo360-dashboard

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY . .

# Build the immutable release while the image is being assembled. Runtime
# containers in Cloud.ru do not need write access to application files.
RUN node scripts/build-resilient-release.mjs

USER node

EXPOSE 8080

# Starting Node directly deliberately bypasses package.json's prestart hook:
# the release has already been built above.
CMD ["node", "server.js"]
