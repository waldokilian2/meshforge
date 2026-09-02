# MeshForge

Self-hosted web app that turns Meshy AI models into downloadable **STL / OBJ / GLB** files. Paste a `meshy.ai/3d-models/...` link, pick a format, download the file. No browser extension needed.

Inspired by [ChesterTheCatt/meshy-ai-to-stl](https://github.com/ChesterTheCatt/meshy-ai-to-stl) — same decode/convert pipeline, moved server-side so it works from any device.

## Quick start

```bash
git clone https://github.com/waldokilian2/meshforge
cd meshforge
docker compose up -d --build
```

Open **http://localhost:3020**, paste a model URL, pick a format, hit **FORGE**.

The Docker build fetches Meshy's decoder (`mesh_loader.js` + `mesh_loader.wasm`) directly from meshy.ai — nothing extra to download or configure.

## How it works

1. Fetch the Meshy model page and extract the signed `model.meshy` URL embedded in it
2. Download the encrypted `.meshy` file
3. Decode it with Meshy's own decoder (authorized locally, the same way the extension does)
4. Convert the GLB to binary STL / OBJ / GLB and serve it as a download

Public community models work out of the box. Private / draft models require a Meshy login and are not reachable.

## Features

- **STL** — binary, print-ready
- **OBJ** — ASCII geometry
- **GLB** — original GLB with textures included
- Converted files are kept in a Docker volume and listed on the page, with per-file delete
- Files auto-purge after 7 days
- Zero runtime dependencies — just Node.js

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MESHFORGE_PORT` | `3020` | Port the server listens on inside the container |
| `MESHFORGE_DATA` | `/data` | Where converted files are stored |

## API

- `POST /api/convert` — body `{"url": "...", "format": "stl|obj|glb"}` → `{"jobId": "..."}`
- `GET /api/job/<id>` — `{"status": "resolving|downloading|decoding|done|error"}`
- `GET /api/download/<id>` — the converted file
- `GET /api/files` — list stored files
- `DELETE /api/files/<id>` — delete a stored file
- `GET /api/health`

## Notes

- This is an unofficial tool and is not affiliated with Meshy. It relies on Meshy's public model pages continuing to serve signed model URLs.
- Intended for personal / LAN use. Don't expose it directly to the internet.
- The Meshy decoder files are downloaded at build time and are not redistributed in this repo.

## License

MIT
