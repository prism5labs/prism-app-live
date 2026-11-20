// Static server for the email-reader repro: serves the worktree's
// public/ on 127.0.0.1:10101. API calls are stubbed in the page via a
// CDP preload (see probe-email.ts), so this server only serves files.
import { file } from "bun";

const ROOT = "/home/hatch/workspace/business/prism-app-worktrees/email-reader-fix/public";
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
};

Bun.serve({
  port: 10101,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    const f = file(`${ROOT}${p}`);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const ext = p.slice(p.lastIndexOf("."));
    return new Response(f, { headers: { "content-type": TYPES[ext] || "application/octet-stream" } });
  },
});
console.log("static server on 127.0.0.1:10101");
