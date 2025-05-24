# Base
FROM node:20 AS base
WORKDIR /iron-bot
COPY package.json package-lock.json tsconfig.json ./
RUN npm install
COPY src ./src

# Dev
FROM base AS dev
CMD ["npm", "run", "dev"]

# Build
FROM base AS build
RUN npm run build

# Prod
FROM node:20-slim AS prod
WORKDIR /iron-bot
COPY --from=build /iron-bot/dist ./dist
COPY package.json ./
RUN npm install --omit=dev

COPY storage /iron-bot/storage
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["entrypoint.sh"]
CMD ["npm", "run", "prod"]
