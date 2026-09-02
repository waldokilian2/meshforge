FROM docker.io/library/node:22-alpine

WORKDIR /app

# Fetch Meshy's decoder files (same files the original browser extension downloads).
# Not redistributed in this repo.
RUN mkdir -p vendor \
 && wget -q -O vendor/mesh_loader.js "https://www.meshy.ai/resource/decrypt/mesh_loader.js" \
 && wget -q -O vendor/mesh_loader.wasm "https://www.meshy.ai/resource/decrypt/mesh_loader.wasm" \
 && test "$(wc -c < vendor/mesh_loader.js)" -gt 0 \
 && test "$(wc -c < vendor/mesh_loader.wasm)" -gt 0

COPY package.json server.js meshlib.js ./
COPY public/ ./public/

ENV NODE_ENV=production
ENV MESHFORGE_PORT=3020
EXPOSE 3020

CMD ["node", "server.js"]
