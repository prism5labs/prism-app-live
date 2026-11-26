// Website newsletter signup test: the "Stay in the loop" form on
// prism5labs.com posts to POST /api/newsletter/subscribe and the
// address lands on the real newsletter list (Nov 26, 2026).
//
//   1. The CORS preflight answers for the site's origin and stays
//      silent for any other origin.
//   2. A valid signup stores one row, source "website", with the
//      welcome still pending (no owner Gmail exists in this env, so
//      nothing can send — the row waits for the drain, by design).
//   3. A repeat signup — any case, padded — answers already = true
//      and writes no second row.
//   4. A malformed email is a 400 and stores nothing.
//   5. A filled honeypot answers a quiet ok and stores nothing.
//   6. A disallowed origin gets no CORS header (the request itself
//      still processes, exactly like /api/demo-request).
//   7. The per-address rate limit trips on the sixth try in the
//      window.
//   8. The unsubscribe link still works, and re-subscribing after
//      it rejoins the list on the same row.
//
// Run: bun scripts/test-newsletter-signup.ts (spawns the real server
// on :3135 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3135;
const DATA_DIR = "/tmp/prism-newsletter-signup-test";
const SITE = "https://prism5labs.com";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

async function startApp() {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${APP_PORT}/healthz`);
      if (r.ok) return proc;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  const errText = await new Response(proc.stderr as any).text().catch(() => "");
  throw new Error(`app did not come up: ${errText.slice(0, 1000)}`);
}

function rows(): any[] {
  const db = new Database(join(DATA_DIR, "app.db"), { readonly: true });
  const out = db.query(`SELECT * FROM newsletter_subscribers`).all() as any[];
  db.close();
  return out;
}

async function preflight(origin: string): Promise<Response> {
  return fetch(`http://localhost:${APP_PORT}/api/newsletter/subscribe`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
  });
}

async function subscribe(
  body: Record<string, string>,
  origin: string | null,
  xff: string,
): Promise<{ status: number; headers: Headers; body: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": xff,
  };
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://localhost:${APP_PORT}/api/newsletter/subscribe`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  // 1 — preflight.
  const pre = await preflight(SITE);
  check(
    "preflight: site origin echoed",
    pre.status === 204 && pre.headers.get("access-control-allow-origin") === SITE,
    `status ${pre.status}`,
  );
  const preBad = await preflight("https://evil.example.com");
  check(
    "preflight: foreign origin gets no allow header",
    preBad.headers.get("access-control-allow-origin") === null,
  );

  // 2 — a real signup.
  const s1 = await subscribe({ email: "Reader.One@Example.com" }, SITE, "10.0.0.1");
  check(
    "signup: 200 ok, not already",
    s1.status === 200 && s1.body?.ok === true && s1.body?.already === false,
    JSON.stringify(s1.body),
  );
  check(
    "signup: CORS header echoes the site origin",
    s1.headers.get("access-control-allow-origin") === SITE,
  );
  let list = rows();
  check(
    "signup: one row stored, lowercased, source website",
    list.length === 1 &&
      list[0].email === "reader.one@example.com" &&
      list[0].source === "website",
    JSON.stringify(list),
  );
  check(
    "signup: welcome pending, token minted",
    list.length === 1 && list[0].welcome_sent_at === null && !!list[0].unsubscribe_token,
  );

  // 3 — repeat signup, different case and padding.
  const s2 = await subscribe({ email: "  reader.one@example.COM " }, SITE, "10.0.0.2");
  check(
    "repeat: answers already = true",
    s2.status === 200 && s2.body?.ok === true && s2.body?.already === true,
    JSON.stringify(s2.body),
  );
  check("repeat: still exactly one row", rows().length === 1);

  // 4 — malformed email.
  const s3 = await subscribe({ email: "not-an-email" }, SITE, "10.0.0.3");
  check(
    "invalid: 400 with a plain message",
    s3.status === 400 && s3.body?.ok === false && typeof s3.body?.message === "string",
    `status ${s3.status}`,
  );
  check("invalid: nothing stored", rows().length === 1);

  // 5 — honeypot.
  const s4 = await subscribe(
    { email: "bot@example.com", website: "http://spam.example" },
    SITE,
    "10.0.0.4",
  );
  check("honeypot: quiet ok", s4.status === 200 && s4.body?.ok === true);
  check(
    "honeypot: nothing stored",
    rows().every((r) => r.email !== "bot@example.com"),
  );

  // 6 — disallowed origin: processed, but no CORS header.
  const s5 = await subscribe(
    { email: "second@example.com" },
    "https://evil.example.com",
    "10.0.0.5",
  );
  check(
    "foreign origin: no CORS header on the response",
    s5.headers.get("access-control-allow-origin") === null && s5.status === 200,
    `status ${s5.status}`,
  );

  // 7 — rate limit: five tries pass, the sixth is a 429.
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const r = await subscribe({ email: `flood${i}@example.com` }, SITE, "10.0.0.9");
    lastStatus = r.status;
  }
  check("rate limit: sixth try in the window is a 429", lastStatus === 429, `got ${lastStatus}`);

  // 8 — unsubscribe, then rejoin on the same row.
  const token = rows().find((r) => r.email === "reader.one@example.com")?.unsubscribe_token;
  const un = await fetch(
    `http://localhost:${APP_PORT}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`,
  );
  check("unsubscribe: link answers 200", un.status === 200);
  const after = rows().find((r) => r.email === "reader.one@example.com");
  check("unsubscribe: row marked", !!after?.unsubscribed_at);
  const s6 = await subscribe({ email: "reader.one@example.com" }, SITE, "10.0.0.6");
  check(
    "rejoin: treated as a fresh signup",
    s6.status === 200 && s6.body?.already === false,
    JSON.stringify(s6.body),
  );
  const rejoined = rows().filter((r) => r.email === "reader.one@example.com");
  check(
    "rejoin: same single row, mark cleared, token unchanged",
    rejoined.length === 1 &&
      rejoined[0].unsubscribed_at === null &&
      rejoined[0].unsubscribe_token === token,
  );
} finally {
  proc.kill();
  await rm(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
