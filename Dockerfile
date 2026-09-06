FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3340
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
USER node
EXPOSE 3340
CMD ["node", "build/relay.mjs"]
