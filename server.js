const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

// Resolve a request path to a file inside root, mirroring how the site
// was saved: directory URLs → index.html, extensionless → /index.html.
async function resolveFile(root, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  rel = rel.replace(/^\/+/, "");
  const base = path.join(root, rel);

  // Block path traversal outside root.
  if (!path.resolve(base).startsWith(path.resolve(root))) return null;

  const candidates = [];
  if (rel === "" || rel.endsWith("/")) {
    candidates.push(path.join(base, "index.html"));
  } else {
    candidates.push(base);
    candidates.push(base + ".html");
    candidates.push(path.join(base, "index.html"));
  }

  for (const c of candidates) {
    try {
      const st = await fsp.stat(c);
      if (st.isFile()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function createServer(root) {
  return http.createServer(async (req, res) => {
    try {
      const file = await resolveFile(root, req.url);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("500 " + e.message);
    }
  });
}

// Starts a server for `root` on `port`. Resolves with { port, close }.
function serve(root, port = 5432) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    // Track sockets so close() frees the port immediately even when a
    // browser keeps keep-alive connections open.
    const sockets = new Set();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            server.close(() => r());
          }),
      });
    });
  });
}

module.exports = { serve, createServer };

// Allow standalone use: node server.js <root> <port>
if (require.main === module) {
  const root = path.resolve(process.argv[2] || ".");
  const port = Number(process.argv[3]) || 5432;
  serve(root, port).then(({ url }) =>
    console.log(`Serving ${root}\n  -> ${url}`)
  );
}
