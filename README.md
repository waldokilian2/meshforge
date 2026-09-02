# MeshForge

Self-hosted web service that converts Meshy AI models into downloadable **STL / OBJ / GLB** files. Paste a `meshy.ai/3d-models/...` link on the web UI, pick a format, download the file. No extension, no browser required.

Server-side port of the approach used by [ChesterTheCatt/meshy-ai-to-stl](https://github.com/ChesterTheCatt/meshy-ai-to-stl) (a Chrome extension that sniffs `.meshy` downloads in the active tab and converts them locally).

## How it works

1. Fetch the Meshy model page and extract the signed `model.meshy` URL embedded in it
2. Download the encrypted `.meshy` file
3. Decode it with Meshy's own emscripten loader (`vendor/mesh_loader.js` + `mesh_loader.wasm`, authorized locally the same way the extension does)
4. Convert the resulting GLB to binary STL / OBJ / GLB and serve it as a download

Public community models work out of the box. Private / draft models require Meshy login and are not reachable.

## Setup

Requirements: Node.js 20+ (tested on 22), curl.

```bash
./setup-vendor.sh   # downloads the decoder files (not redistributed in this repo)
node server.js      # listens on :3020
```

Open `http://<host>:3020`, paste a model URL, choose a format.

## API

- `POST /api/convert` — body `{"url": "...", "format": "stl|obj|glb"}` → `{"jobId": "..."}`
- `GET /api/job/<id>` — `{"status": "resolving|downloading|decoding|done|error", ...}`
- `GET /api/download/<id>` — the converted file
- `GET /api/health`

## Deployment (quadlet)

`meshforge.container` runs the service as a systemd-managed Podman container (image `localhost/meshforge:latest`, built from the Dockerfile, published to loopback `127.0.0.1:3020` behind a reverse proxy).

## License

MIT
