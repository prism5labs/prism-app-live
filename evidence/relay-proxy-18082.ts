// Local unauthenticated forward proxy for headless Chrome (node:net).
// Chrome -> http://127.0.0.1:18082 (plain, no auth) -> relay ->
// authenticated CONNECT to the sandbox egress proxy (creds from env) -> internet.
// No secrets are written here: egress credentials are read from process.env.
import net from "node:net";

const LISTEN_PORT = 18082;
const EGRESS_HOST = "hatch-egress-proxy";
const EGRESS_PORT = 3128;

const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || "";
const m = proxyUrl.match(/^https?:\/\/([^:]+):([^@]+)@/);
if (!m) {
  console.error("no egress proxy credentials in env");
  process.exit(1);
}
const proxyAuth = "Basic " + Buffer.from(`${m[1]}:${m[2]}`).toString("base64");
const log = (...a: any[]) => console.error(new Date().toISOString(), ...a);

const server = net.createServer((client) => {
  let buf = Buffer.alloc(0);
  let upstream: net.Socket | null = null;
  let established = false;

  client.on("data", (chunk: Buffer) => {
    try {
      if (established && upstream) {
        upstream.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      buf = Buffer.alloc(0);
      const [requestLine, ...headerLines] = head.split("\r\n");
      const [method, target] = requestLine.split(" ");
      log("REQ", method, target);
      if (method === "CONNECT") {
        const [host, port] = target.split(":");
        // Local dev servers: connect directly instead of via the egress proxy.
        if (host === "localhost" || host === "127.0.0.1" || host === "prism-local.example.com") {
          const direct = net.connect(Number(port), "127.0.0.1", () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            established = true;
            upstream = direct;
            if (rest.length) direct.write(rest);
          });
          direct.on("data", (d: Buffer) => client.write(d));
          direct.on("close", () => client.end());
          direct.on("error", (e) => {
            log("direct error", String(e));
            try {
              client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            } catch {}
            client.end();
          });
          return;
        }
        upstream = net.connect(EGRESS_PORT, EGRESS_HOST, () => {
          upstream!.write(
            `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: ${proxyAuth}\r\nProxy-Connection: keep-alive\r\n\r\n`,
          );
        });
        let upBuf = Buffer.alloc(0);
        let handshook = false;
        upstream.on("data", (d: Buffer) => {
          if (!handshook) {
            upBuf = Buffer.concat([upBuf, d]);
            const e = upBuf.indexOf("\r\n\r\n");
            if (e === -1) return;
            const respHead = upBuf.subarray(0, e).toString("latin1");
            const status = parseInt(respHead.split(" ")[1] || "0", 10);
            const leftover = upBuf.subarray(e + 4);
            upBuf = Buffer.alloc(0);
            log("EGRESS status for", target, "=", status);
            if (status === 200) {
              handshook = true;
              established = true;
              client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
              if (leftover.length) upstream!.write(leftover);
              if (rest.length) upstream!.write(rest);
            } else {
              client.write(`HTTP/1.1 ${status} Proxy Error\r\n\r\n`);
              client.end();
              upstream!.end();
            }
          } else {
            client.write(d);
          }
        });
        upstream.on("close", () => client.end());
        upstream.on("error", (e) => {
          log("upstream error", String(e));
          try {
            client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          } catch {}
          client.end();
        });
      } else {
        // Plain HTTP with absolute URI. Local dev servers go direct.
        const mLocal = target.match(/^http:\/\/([^/:]+):(\d+)(\/.*)?$/);
        if (mLocal && (mLocal[1] === "localhost" || mLocal[1] === "127.0.0.1" || mLocal[1] === "prism-local.example.com")) {
          const localPort = Number(mLocal[2]);
          const localPath = mLocal[3] || "/";
          const localLines = [`${method} ${localPath} HTTP/1.1`];
          for (const l of headerLines) {
            if (/^proxy-authorization:/i.test(l)) continue;
            if (/^connection:/i.test(l)) continue;
            if (/^host:/i.test(l)) continue;
            localLines.push(l);
          }
          localLines.push(`Host: localhost:${localPort}`, "Connection: close", "");
          const u = net.connect(localPort, "127.0.0.1", () => {
            u.write(Buffer.concat([Buffer.from(localLines.join("\r\n") + "\r\n", "latin1"), rest]));
          });
          upstream = u;
          established = true;
          u.on("data", (d: Buffer) => client.write(d));
          u.on("close", () => client.end());
          u.on("error", () => client.end());
          return;
        }
        const lines = [requestLine];
        let hasAuth = false;
        for (const l of headerLines) {
          if (/^proxy-authorization:/i.test(l)) {
            hasAuth = true;
            continue;
          }
          if (/^connection:/i.test(l)) continue;
          lines.push(l);
        }
        if (!hasAuth) lines.push(`Proxy-Authorization: ${proxyAuth}`);
        lines.push("Connection: close", "");
        const u = net.connect(EGRESS_PORT, EGRESS_HOST, () => {
          u.write(Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n", "latin1"), rest]));
        });
        upstream = u;
        established = true;
        u.on("data", (d: Buffer) => client.write(d));
        u.on("close", () => client.end());
        u.on("error", () => client.end());
      }
    } catch (e) {
      log("client data handler threw:", String(e));
      try {
        client.end();
      } catch {}
    }
  });
  client.on("close", () => {
    try {
      upstream?.end();
    } catch {}
  });
  client.on("error", () => {
    try {
      upstream?.end();
    } catch {}
  });
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  log(`relay listening on 127.0.0.1:${LISTEN_PORT}`);
});
