// Verify the memory import fix end to end (local only, never production).
// Imports the real Nov 17 self-export into a throwaway database and
// checks the brain would actually know Neil afterwards:
//   1. The whole file is stored (no 100,000-character cut).
//   2. It is split into its sections, tail included.
//   3. The identity block names Neil, Calyn, and Harvey.
//   4. The persona seed carries SOUL/IDENTITY and never the free-code section.
//   5. Retrieval answers a content question from the matching section,
//      never from the file's head (the old table-of-contents reply).
//   6. The system prompt puts the persona seed first and names the owner.
//   7. An old whole-file import is split in place by the migration.
//   8. Deleting an import removes the whole sectioned group.
// Usage: DATA_DIR=/tmp/prism-memory-import-test bun scripts/test-memory-import.ts
//   (exit 0 = all pass)
// Nothing in this file prints the export's contents: only counts and
// PASS/FAIL lines. The export itself is private and stays out of logs.

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "/tmp/prism-memory-import-test";
const EXPORT_PATH =
  process.env.EXPORT_PATH ||
  join(process.env.HOME || "/home/hatch", "workspace/your_files/prism-5-self-export-2026-11-17.txt");

// Fresh database every run: wipe before the db module is loaded.
await rm(DATA_DIR, { recursive: true, force: true });

const {
  db,
  isSelfExport,
  splitSelfExport,
  addImportedMemory,
  listImportedMemory,
  deleteImportedMemory,
  memoryDigest,
  identityBlock,
  personaSeed,
  migrateUnsectionedSelfExports,
} = await import("../src/server/db");
const { systemPromptFor } = await import("../src/server/personas");
import type { OwnerContext } from "../src/server/personas";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const text = readFileSync(EXPORT_PATH, "utf-8");
console.log(`export: ${text.length.toLocaleString()} characters`);
const acct = "test-memory-import-01";
const oldAcct = "test-memory-import-02";

// 1. Detection and splitting.
check("export is detected as a self-export", isSelfExport(text));
const sections = splitSelfExport(text);
check("export splits into 12 sections (preamble + 11 headers)", sections.length === 12, `got ${sections.length}`);
const titles = sections.map((s) => s.title);
for (const want of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "People Index", "Groups Index"]) {
  check(`section present: ${want}`, titles.includes(want));
}
check(
  "tail section present (the old cap cut it off)",
  titles.some((t) => t.includes("Friends & Family free code")),
);

// 2. The whole file is stored.
const row = addImportedMemory(acct, "Notes file", "prism-5-self-export-2026-11-17", text);
check("stored chars cover the whole file", row.chars > 140_000, `${row.chars.toLocaleString()} chars`);
check("import reports its section count", row.sections === 12, `got ${row.sections}`);
const listed = listImportedMemory(acct);
check("list shows one grouped import", listed.length === 1, `got ${listed.length}`);
check("listed import sums its sections", listed[0]?.sections === 12 && (listed[0]?.chars || 0) > 140_000, `${(listed[0]?.chars || 0).toLocaleString()} chars, ${listed[0]?.sections} sections`);

// 3. The identity block knows the owner.
const identity = identityBlock(acct);
check("identity block names Neil", identity.includes("Neil Joseph Saindon"));
check("identity block names Calyn", identity.includes("Calyn"));
check("identity block names Harvey", identity.includes("Harvey"));
check("identity block is compact", identity.length <= 3000, `${identity.length} chars`);
check("identity block has no table of contents", !identity.includes("WHAT IS IN HERE"));
check("identity block never carries the free-code section", !identity.includes("Friends & Family free code"));

// 4. The persona seed carries SOUL/IDENTITY and nothing else sensitive.
const seed = personaSeed(acct);
check("persona seed exists", !!seed);
check("persona seed carries the Jeeves persona", !!seed && seed.includes("Jeeves"));
check("persona seed never carries the free-code section", !!seed && !seed.includes("Friends & Family free code"));

// 5. Retrieval answers from the matching section, not the file's head.
const digest = memoryDigest(acct, "What Mounjaro dose am I on?");
check("digest answers the Mounjaro question", digest.includes("Mounjaro"));
check("digest is not the table of contents", !digest.includes("WHAT IS IN HERE"));
check("digest never carries the free-code section", !digest.includes("Friends & Family free code"));
check("digest is bounded", digest.length <= 6000, `${digest.length} chars`);
check("no match means no digest", memoryDigest(acct, "zxqv wibble florp") === "");
check("no message means no digest", memoryDigest(acct) === "");

// 6. The system prompt puts the seed first and names the owner.
const owner: OwnerContext = {
  name: "Neil Joseph Saindon",
  about: null,
  preferences: null,
  notes: null,
  title: null,
  pronouns: null,
  memoryDigest: digest,
  personaSeed: seed,
  identityBlock: identity,
};
const prompt = systemPromptFor("Prism", "Prism", null, owner);
check("prompt names the owner", prompt.includes("Their name is Neil Joseph Saindon"));
check("prompt carries the identity block", prompt.includes("Calyn") && prompt.includes("Harvey"));
check(
  "persona seed comes before the default persona",
  prompt.indexOf("Jeeves") >= 0 && prompt.indexOf("Jeeves") < prompt.indexOf("You are Prism 5, the first of the Photons"),
);
check("prompt never carries the free-code section", !prompt.includes("Friends & Family free code"));
check("prompt has no table of contents", !prompt.includes("WHAT IS IN HERE"));

// 7. An old whole-file import is split in place by the migration.
const truncated = text.slice(0, 100_000);
db.query(
  `INSERT INTO imported_memory (account_id, source, title, content, imported_at)
   VALUES (?, ?, ?, ?, ?)`,
).run(oldAcct, "Notes file", "prism-5-self-export-2026-11-17", truncated, new Date().toISOString());
const migrated = migrateUnsectionedSelfExports();
check("migration splits the old import", migrated === 1, `migrated ${migrated}`);
const oldListed = listImportedMemory(oldAcct);
check("migrated import lists as one grouped entry", oldListed.length === 1 && oldListed[0].sections >= 6, `got ${oldListed[0]?.sections} sections`);
check("migrated import keeps most of its text", (oldListed[0]?.chars || 0) > 90_000, `${(oldListed[0]?.chars || 0).toLocaleString()} chars`);
const oldIdentity = identityBlock(oldAcct);
check("migrated import yields an identity block", oldIdentity.includes("Neil Joseph Saindon"));

// 8. Deleting an import removes the whole sectioned group.
deleteImportedMemory(acct, row.id);
check("delete removes the whole group", listImportedMemory(acct).length === 0);
deleteImportedMemory(oldAcct, oldListed[0].id);
check("delete removes the migrated group", listImportedMemory(oldAcct).length === 0);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
