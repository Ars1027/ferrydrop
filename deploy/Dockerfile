FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci && npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8443 DATA_DIR=/data TLS_CERT=/certs/server.pem TLS_KEY=/certs/server-key.pem
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8443
CMD ["npm","start"]
