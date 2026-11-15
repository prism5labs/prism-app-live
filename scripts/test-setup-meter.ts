// One-off test setup: give an account one owned Photon and a full meter,
// without the free code or Upkeep, so the meter_exhausted path can be tested.
// Usage: DATA_DIR=/tmp/prism-standalone-test bun scripts/test-setup-meter.ts <accountId>
import { Database } from "bun:sqlite";
import { join } from "node:path";

const dataDir = process.env.DATA_DIR || "./data";
const accountId = process.argv[2] || "meterfull001";
const db = new Database(join(dataDir, "app.db"));
const now = new Date().toISOString();
const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
db.query(`INSERT OR IGNORE INTO accounts (id, created_at, meter_month) VALUES (?, ?, ?)`).run(
  accountId,
  now,
  month,
);
db.query(`UPDATE accounts SET meter_used = 300, meter_month = ?, free_code = 0, upkeep = 0 WHERE id = ?`).run(
  month,
  accountId,
);
db.query(
  `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'photon', 'Prism', ?)`,
).run(accountId, now);
console.log(`set up ${accountId}: owns Prism, meter 300/300, not unlimited`);
