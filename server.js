// MeshForge — server.js
// Paste a meshy.ai model link -> server fetches .meshy -> decodes -> serves STL/OBJ/GLB.
// Zero npm dependencies: node:http + node:crypto only.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMeshy, glbToBinaryStl, glbToObj, vendorStatus } from "./meshlib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MESHFORGE_PORT || 3020;
const HOST = process.env.MESHFORGE_HOST || "0.0.0.0";
const STORAGE = process.env.MESHFORGE_DATA || "/data";
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB cap on .meshy download
const FILE_TTL_DAYS = 7;

fs.mkdirSync(STORAGE, { recursive: true });

const EXT = { stl: "stl", obj: "obj", glb: "glb" };

function metaPath(id) { return path.join(STORAGE, `${id}.json`); }
function filePath(id, ext) { return path.join(STORAGE, `${id}.${ext}`); }

function readStoredFiles() {
  const files = [];
  for (const name of fs.readdirSync(STORAGE)) {
    if (!name.endsWith(".json")) continue;
    try {
      files.push(JSON.parse(fs.readFileSync(path.join(STORAGE, name), "utf8")));
    } catch { /* skip corrupt meta */ }
  }
  return files.sort((a, b) => b.created - a.created);
}

// Auto-purge files older than FILE_TTL_DAYS
setInterval(() => {
  const cutoff = Date.now() - FILE_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const meta of readStoredFiles()) {
    if (meta.created < cutoff) {
      try { fs.rmSync(filePath(meta.id, meta.ext), { force: true }); fs.rmSync(metaPath(meta.id), { force: true }); } catch {}
    }
  }
}, 60 * 60 * 1000).unref();

// ---------- helpers ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json" });
}

function fetchWithUA(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      ...(opts.headers || {}),
    },
    redirect: "follow",
  });
}

// Extract a model.meshy URL from a Meshy model page URL.
async function resolveMeshyUrl(pageUrl) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (url.hostname !== "www.meshy.ai" && url.hostname !== "meshy.ai") {
    throw new Error("Only meshy.ai model pages are supported");
  }

  const resp = await fetchWithUA(url.href);
  if (!resp.ok) throw new Error(`Meshy returned HTTP ${resp.status} for that page`);
  const html = await resp.text();

  // Prefer signed misc/cdn-models URLs (.meshy) embedded in the page.
  const patterns = [
    /https?:\\?\/\\?\/api\.meshy\.ai\\?\/misc\\?\/cdn-models\\?\/[^"'\\\s<>]+model\.meshy\?sign=[^"'\\\s<>]+/gi,
    /https?:\\?\/\\?\/[a-z0-9.-]*meshy\.ai\\?\/[^"'\\\s<>]*\.meshy\?[^"'\\\s<>]+/gi,
    /https?:\\?\/\\?\/[a-z0-9.-]*meshy\.ai\\?\/[^"'\\\s<>]*\/model\.meshy[^"'\\\s<>]*/gi,
  ];
  for (const pattern of patterns) {
    const matches = html.match(pattern) || [];
    for (const raw of matches) {
      const cleaned = raw.replace(/\\\//g, "/").replace(/&amp;/g, "&");
      return cleaned;
    }
  }

  // Last resort: any .meshy mention
  const loose = html.match(/[^"'\s<>]+\.meshy[^"'\s<>]*/i);
  if (loose) return loose[0].replace(/&amp;/g, "&");

  throw new Error(
    "No .meshy model URL found on that page. Is it a public model page (meshy.ai/3d-models/...)? Private or draft models are not reachable without login."
  );
}

async function downloadMeshy(url) {
  const resp = await fetchWithUA(url);
  if (!resp.ok) throw new Error(`Downloading .meshy failed: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("File exceeds 200 MB limit");
  if (buf.length < 32) throw new Error("Downloaded file is not a valid .meshy payload");
  return buf;
}

function safeName(input, ext) {
  const base = String(input || "model")
    .replace(/^.*\/3d-models\//, "") // model page slug
    .replace(/\.meshy.*$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80) || "model";
  return `${base}.${ext}`;
}

// ---------- job store (in-progress conversions only; finished files persist to disk) ----------

const jobs = new Map(); // jobId -> { status, format, name, error?, created }

async function runJob(jobId, meshyUrl, format, slug) {
  const job = jobs.get(jobId);
  try {
    job.status = "downloading";
    const buf = await downloadMeshy(meshyUrl);
    job.status = "decoding";
    let out;
    if (format === "glb") {
      out = await decodeMeshy(buf);
    } else if (format === "stl") {
      out = glbToBinaryStl(await decodeMeshy(buf));
    } else if (format === "obj") {
      out = glbToObj(await decodeMeshy(buf));
    } else {
      throw new Error("Unsupported format");
    }
    const ext = EXT[format];
    fs.writeFileSync(filePath(jobId, ext), out);
    const meta = {
      id: jobId,
      name: safeName(slug, format),
      ext,
      size: out.length,
      source: String(slug || ""),
      created: Date.now(),
    };
    fs.writeFileSync(metaPath(jobId), JSON.stringify(meta));
    job.status = "done";
    job.name = meta.name;
    job.id = jobId;
  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
  }
}

// ---------- UI ----------

const indexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"));

// ---------- routes ----------

async function handler(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return send(res, 200, indexHtml, { "Content-Type": MIME[".html"] });
    }

    if (req.method === "GET" && p === "/health") {
      return json(res, 200, { ok: true, vendor: await vendorStatus(), jobs: jobs.size });
    }

    if (req.method === "GET" && p === "/api/files") {
      return json(res, 200, { files: readStoredFiles() });
    }

    if (req.method === "DELETE" && p.startsWith("/api/files/")) {
      const id = path.basename(p).replace(/\.(json|stl|obj|glb)$/, "");
      const metaFile = metaPath(id);
      if (!fs.existsSync(metaFile)) return json(res, 404, { error: "unknown file" });
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      fs.rmSync(filePath(id, meta.ext), { force: true });
      fs.rmSync(metaFile, { force: true });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && p === "/api/convert") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 10000) req.destroy();
      });
      req.on("end", async () => {
        try {
          const { url, format } = JSON.parse(body);
          if (!url || !format) return json(res, 400, { error: "url and format required" });
          if (!["stl", "obj", "glb"].includes(format)) return json(res, 400, { error: "format must be stl, obj, or glb" });

          const meshyUrl = await resolveMeshyUrl(url);
          const slug = new URL(url).pathname.split("/").pop() || "model";
          const jobId = crypto.randomUUID();
          jobs.set(jobId, { status: "resolving", created: Date.now(), format, meshyUrl, slug });
          runJob(jobId, meshyUrl, format, slug); // async, do not await
          return json(res, 200, { jobId });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      });
      return;
    }

    if (req.method === "GET" && p.startsWith("/api/job/")) {
      const jobId = p.slice("/api/job/".length);
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: "unknown job" });
      return json(res, 200, { status: job.status, error: job.error || null, name: job.name || null });
    }

    if (req.method === "GET" && p.startsWith("/api/download/")) {
      const id = path.basename(p);
      // Live job…
      const job = jobs.get(id);
      if (job && job.status === "done") {
        const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
        const buf = fs.readFileSync(filePath(id, meta.ext));
        return send(res, 200, buf, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${meta.name}"`,
          "Content-Length": buf.length,
        });
      }
      // …or persisted file.
      const metaFile = metaPath(id);
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        const buf = fs.readFileSync(filePath(id, meta.ext));
        return send(res, 200, buf, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${meta.name}"`,
          "Content-Length": buf.length,
        });
      }
      return json(res, 404, { error: "unknown job" });
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: err.message || "internal error" });
  }
}

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`MeshForge listening on http://${HOST}:${PORT}`);
});
