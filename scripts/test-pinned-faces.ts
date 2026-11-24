// Pinned Faces test: a user can pin a Photon or Atom conversation,
// list the pins in pinned order, re-pin idempotently, and unpin.
//
//   1. Pin then list: pinning Prism then Mabel lists both in order.
//   2. Idempotent re-pin: pinning Prism again does not duplicate it
//      or move it.
//   3. Unpin removes the Face; unpinning again is a clean no-op.
//   4. Account isolation: another account sees none of these pins,
//      and unpinning there does not touch the first account.
//   5. An unknown name is a 400, and a missing account id is a 400
//      on list, pin, and unpin.
//   6. The client carries the pinned API, the Pin/Unpin control in
//      the thread head, and the Pinned section on the Chat front.
//
// Run: bun scripts/test-pinned-faces.ts (spawns the real server on
// :3128 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3128;
const DATA_DIR = "/tmp/prism-pinned-faces-test";
const ACCOUNT = "acc_pinnedtest0123456";
const OTHER = "acc_pinnedother012345";

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

async function pinnedList(accountId: string): Promise<any> {
  const res = await fetch(
    `http://localhost:${APP_PORT}/api/pinned?accountId=${accountId}`,
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function pinVerb(accountId: string | null, name: string, verb: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accountId) headers["x-account-id"] = accountId;
  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/${name}/${verb}`, {
    method: "POST",
    headers,
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);

  // Initially nothing is pinned.
  const empty = await pinnedList(ACCOUNT);
  check(
    "list: initially empty",
    empty.status === 200 && empty.body?.ok === true && Array.isArray(empty.body?.pinned) && empty.body.pinned.length === 0,
    `${empty.status} ${JSON.stringify(empty.body)}`,
  );

  // Pin then list (a Photon and an Atom), in pinned order.
  const pin1 = await pinVerb(ACCOUNT, "Prism", "pin");
  check(
    "pin: Prism returns pinned true",
    pin1.status === 200 && pin1.body?.ok === true && pin1.body?.pinned === true,
    `${pin1.status} ${JSON.stringify(pin1.body)}`,
  );
  const pin2 = await pinVerb(ACCOUNT, "Mabel", "pin");
  check("pin: Atom Mabel returns pinned true", pin2.status === 200 && pin2.body?.pinned === true);
  const listed = await pinnedList(ACCOUNT);
  check(
    "list: pins in pinned order",
    listed.status === 200 &&
      JSON.stringify(listed.body?.pinned) === JSON.stringify(["Prism", "Mabel"]),
    JSON.stringify(listed.body),
  );

  // Idempotent re-pin: no duplicate, no reorder.
  const repin = await pinVerb(ACCOUNT, "Prism", "pin");
  const afterRepin = await pinnedList(ACCOUNT);
  check(
    "re-pin: idempotent, no duplicate or reorder",
    repin.status === 200 &&
      repin.body?.pinned === true &&
      JSON.stringify(afterRepin.body?.pinned) === JSON.stringify(["Prism", "Mabel"]),
    JSON.stringify(afterRepin.body),
  );

  // Unpin removes it; a second unpin is a clean no-op.
  const unpin = await pinVerb(ACCOUNT, "Prism", "unpin");
  check(
    "unpin: returns pinned false",
    unpin.status === 200 && unpin.body?.ok === true && unpin.body?.pinned === false,
    `${unpin.status} ${JSON.stringify(unpin.body)}`,
  );
  const afterUnpin = await pinnedList(ACCOUNT);
  check(
    "unpin: list no longer carries Prism",
    JSON.stringify(afterUnpin.body?.pinned) === JSON.stringify(["Mabel"]),
    JSON.stringify(afterUnpin.body),
  );
  const unpinAgain = await pinVerb(ACCOUNT, "Prism", "unpin");
  const afterUnpinAgain = await pinnedList(ACCOUNT);
  check(
    "unpin: second unpin is a no-op",
    unpinAgain.status === 200 &&
      JSON.stringify(afterUnpinAgain.body?.pinned) === JSON.stringify(["Mabel"]),
    JSON.stringify(afterUnpinAgain.body),
  );

  // Account isolation.
  const otherList = await pinnedList(OTHER);
  check(
    "isolation: other account sees no pins",
    otherList.status === 200 && Array.isArray(otherList.body?.pinned) && otherList.body.pinned.length === 0,
    JSON.stringify(otherList.body),
  );
  await pinVerb(OTHER, "Mabel", "unpin");
  const firstAfterOther = await pinnedList(ACCOUNT);
  check(
    "isolation: other account's unpin leaves the first account alone",
    JSON.stringify(firstAfterOther.body?.pinned) === JSON.stringify(["Mabel"]),
    JSON.stringify(firstAfterOther.body),
  );

  // Unknown name is a 400 on pin and unpin.
  const unknownPin = await pinVerb(ACCOUNT, "Nobody", "pin");
  check(
    "unknown name: pin is 400 unknown photon",
    unknownPin.status === 400 && unknownPin.body?.error === "unknown photon",
    `${unknownPin.status} ${JSON.stringify(unknownPin.body)}`,
  );
  const unknownUnpin = await pinVerb(ACCOUNT, "Nobody", "unpin");
  check(
    "unknown name: unpin is 400 unknown photon",
    unknownUnpin.status === 400 && unknownUnpin.body?.error === "unknown photon",
    `${unknownUnpin.status} ${JSON.stringify(unknownUnpin.body)}`,
  );

  // Missing account is a 400 on list, pin, and unpin.
  const noAccountList = await fetch(`http://localhost:${APP_PORT}/api/pinned`);
  const noAccountListBody: any = await noAccountList.json().catch(() => null);
  check(
    "missing account: list is 400 accountId required",
    noAccountList.status === 400 && noAccountListBody?.error === "accountId required",
    `${noAccountList.status} ${JSON.stringify(noAccountListBody)}`,
  );
  const noAccountPin = await pinVerb(null, "Prism", "pin");
  check(
    "missing account: pin is 400 accountId required",
    noAccountPin.status === 400 && noAccountPin.body?.error === "accountId required",
    `${noAccountPin.status} ${JSON.stringify(noAccountPin.body)}`,
  );
  const noAccountUnpin = await pinVerb(null, "Prism", "unpin");
  check(
    "missing account: unpin is 400 accountId required",
    noAccountUnpin.status === 400 && noAccountUnpin.body?.error === "accountId required",
    `${noAccountUnpin.status} ${JSON.stringify(noAccountUnpin.body)}`,
  );

  // The account id also arrives by header on the list, as elsewhere.
  const byHeader = await fetch(`http://localhost:${APP_PORT}/api/pinned`, {
    headers: { "x-account-id": ACCOUNT },
  });
  const byHeaderBody: any = await byHeader.json().catch(() => null);
  check(
    "list: x-account-id header accepted",
    byHeader.status === 200 && JSON.stringify(byHeaderBody?.pinned) === JSON.stringify(["Mabel"]),
    `${byHeader.status} ${JSON.stringify(byHeaderBody)}`,
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Client and server wiring ---
{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check(
    "client: thread head carries a Pin/Unpin control reflecting state",
    main.includes('"pin-face"') && main.includes('"unpin-face"') && main.includes("isPinnedFace(p.name)"),
  );
  check(
    "client: Chat front renders a Pinned section first for owned Faces",
    main.includes(">Pinned</h2>") || main.includes("Pinned</h2>"),
  );
  check(
    "client: pinned state is loaded with state and with the thread",
    main.includes("loadPinnedFaces()"),
  );
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check(
    "client: api carries pinned/pin/unpin",
    apiClient.includes("/api/pinned?accountId=") &&
      apiClient.includes("/pin`") || apiClient.includes("/pin\"") || apiClient.includes("/pin"),
  );
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check(
    "server: pinned routes are mounted",
    server.includes("/api/pinned") && server.includes("pinFace") && server.includes("listPinnedFaces"),
  );
  const db = readFileSync(join(ROOT, "src", "server", "db.ts"), "utf8");
  check(
    "db: pinned_faces table and helpers exist",
    db.includes("pinned_faces") && db.includes("isFacePinned"),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
