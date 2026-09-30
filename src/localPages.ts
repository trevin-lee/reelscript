/**
 * Local pages (`goto("./app.html")`), served over http from this machine
 * rather than opened as file:// URLs, so they behave as they would on a
 * site: their fetch("/api/...") calls reach mockAPI, their cookies are kept,
 * ES modules load, and video can seek. The server listens on 127.0.0.1 only,
 * on a port of its own, and every path starts with a random token, so no
 * other page can reach it. A file keeps its absolute path under the token, so
 * a page's relative links to files beside it (../assets) still work.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { extname, join } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
};

export class LocalPages {
  private server: Server | null = null;
  private origin = "";
  private readonly token = randomBytes(12).toString("hex");

  /** The http URL that serves a file:// URL, its query and hash kept. */
  async url(fileUrl: string): Promise<string> {
    await this.start();
    const u = new URL(fileUrl);
    return `${this.origin}/${this.token}${u.pathname}${u.search}${u.hash}`;
  }

  /** The file:// URL a served page stands for, or any other URL as it is. */
  file(url: string): string {
    const prefix = `${this.origin}/${this.token}/`;
    if (!this.origin || !url.startsWith(prefix)) return url;
    const u = new URL(url);
    return `file://${u.pathname.slice(this.token.length + 1)}${u.search}${u.hash}`;
  }

  /** Whether a URL is on this server: a local page, or a request one made to its own site. */
  isLocal(url: string): boolean {
    return !!this.origin && url.startsWith(`${this.origin}/`);
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  private async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (!path.startsWith(`/${this.token}/`)) {
        res.writeHead(404).end();
        return;
      }
      let file = decodeURIComponent(path.slice(this.token.length + 1));
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { "content-type": "text/plain" }).end(`not found: ${file}`);
        return;
      }
      const size = statSync(file).size;
      const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      // Ranges, so a video can be moved to the page clock's time.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range && size > 0) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "cache-control": "no-store" });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size, "cache-control": "no-store" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    server.unref();
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
}
