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
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB cap on .meshy download

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

// ---------- job store (simple in-memory cache of finished conversions) ----------

const jobs = new Map(); // jobId -> { status, format, name, buffer?, error?, created }
const JOB_TTL = 30 * 60 * 1000; // 30 min
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL) jobs.delete(id);
  }
}, 60 * 1000).unref();

async function runJob(jobId, meshyUrl, format, slug) {
  const job = jobs.get(jobId);
  try {
    job.status = "downloading";
    const buf = await downloadMeshy(meshyUrl);
    job.status = "decoding";
    let out;
    if (format === "glb") {
      const glb = await decodeMeshy(buf);
      out = { main: glb, extra: [] };
    } else if (format === "stl") {
      const glb = await decodeMeshy(buf);
      out = { main: glbToBinaryStl(glb), extra: [] };
    } else if (format === "obj") {
      const glb = await decodeMeshy(buf);
      out = { main: glbToObj(glb), extra: [] };
    } else {
      throw new Error("Unsupported format");
    }
    job.status = "done";
    job.buffer = out.main;
    job.name = safeName(slug, format);
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
      const jobId = p.slice("/api/download/".length);
      const job = jobs.get(jobId);
      if (!job) return json(res, 404, { error: "unknown job" });
      if (job.status !== "done") return json(res, 409, { error: `job is ${job.status}` });
      return send(res, 200, job.buffer, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${job.name}"`,
        "Content-Length": job.buffer.length,
      });
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
