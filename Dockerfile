FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY ui/package.json ui/
RUN npm ci
COPY . .
RUN npm run build -w @motif/ui && npm run build -w getmotif

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/cli/dist ./dist
VOLUME /data
ENV MOTIF_DB_PATH=/data/motif.db
ENV MOTIF_PORT=4680
EXPOSE 4680
CMD ["node", "dist/index.js", "server", "--host", "0.0.0.0"]
