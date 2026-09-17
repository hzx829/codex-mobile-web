FROM node:24-alpine
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3340
COPY build/relay.mjs ./build/relay.mjs
COPY dist ./dist
USER node
EXPOSE 3340
CMD ["node", "build/relay.mjs"]
