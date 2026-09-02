FROM docker.io/library/node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js meshlib.js ./
COPY vendor/ ./vendor/
COPY public/ ./public/

ENV NODE_ENV=production
ENV MESHFORGE_PORT=3020
EXPOSE 3020

CMD ["node", "server.js"]
