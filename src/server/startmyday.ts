// Start My Day — the morning briefing Plug.
//
// The briefing gathers today's items (calendar events, reminders, and
// items added during the day) and walks the owner through them one at a
// time, top level. Nothing is edited until the owner confirms that item:
// the client only calls /api/day/confirm after a tap, and the server
// only edits inside that call. Reads never change anything.
//
// This module owns its own table (day_items, created at import, like
// db.ts and proactive.ts) and reads the reminders table proactive.ts
// owns. It must not depend on server.ts, so the coordinator wires it
// with one call: handleDayApi(req, path) before the final 404.
//
// Honest limits, stated here so no Photon ever claims otherwise:
//   - Calendar events come from the connected Google Calendar only.
//     When Calendar is not connected, the briefing says so plainly and
//     lists no events; it never invents them.
//   - A calendar event has no "done" state: confirming one keeps it,
//     moving it cancels and rebooks it, cancelling it deletes it.
//     A move books the new time FIRST and cancels the old one after, so
//     a failed booking never loses the event; if the cancel then fails,
//     the response says so plainly and names both events.
//   - A move keeps the event's title, description, attendees, and
//     location. (bookCalendarEvent takes a location; see google.ts.)
//   - Reminders have no "done at" stamp, so the briefing cannot count
//     reminders finished today; it counts added items finished today.

import { db } from "./db";
import { listReminders, markReminderDone } from "./proactive";
import {
  listCalendarEvents,
  bookCalendarEvent,
  cancelCalendarEvent,
  calendarStatus,
} from "./google";

// --- Own table (created at import, like db.ts) ---
db.exec(`
CREATE TABLE IF NOT EXISTS day_items (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  due TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_day_items_account ON day_items (account_id, status, due);
`);

// --- Small local helpers (server.ts has its own; this module must not
// depend on it, so it can be wired by the coordinator with one call) ---
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function accountIdFrom(req: Request, body: any): string {
  const fromBody = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = req.headers.get("x-account-id") || "";
  if (fromHeader.trim()) return fromHeader.trim();
  const url = new URL(req.url);
  return (url.searchParams.get("accountId") || "").trim();
}

function isValidAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id);
}

// --- Day items (added during the day, tracked in the plan) ---
export type DayItemRow = {
  id: string;
  account_id: string;
  title: string;
  detail: string | null;
  due: string | null;
  status: "open" | "done" | "skipped";
  created_at: string;
  updated_at: string;
};

function newDayItemId(): string {
  return "day_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function rowToDayItem(row: any): DayItemRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    title: String(row.title),
    detail: row.detail == null ? null : String(row.detail),
    due: row.due == null ? null : String(row.due),
    status: row.status === "done" ? "done" : row.status === "skipped" ? "skipped" : "open",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function listDayItems(accountId: string): DayItemRow[] {
  const rows = db
    .query(`SELECT * FROM day_items WHERE account_id = ? ORDER BY created_at ASC`)
    .all(accountId) as any[];
  return rows.map(rowToDayItem);
}

export function createDayItem(
  accountId: string,
  title: string,
  detail: string | null,
  due: string | null,
): DayItemRow {
  const now = new Date().toISOString();
  const id = newDayItemId();
  db.query(
    `INSERT INTO day_items (id, account_id, title, detail, due, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(id, accountId, title, detail, due, now, now);
  return rowToDayItem(db.query(`SELECT * FROM day_items WHERE id = ?`).get(id));
}

// Move a reminder to a new time. The reminders table is owned by
// proactive.ts; this updates only the time, never the text or state.
function moveReminder(accountId: string, id: string, remindAt: string): boolean {
  const r = db
    .query(`UPDATE reminders SET remind_at = ? WHERE account_id = ? AND id = ? AND done = 0`)
    .run(remindAt, accountId, id);
  return r.changes > 0;
}

// --- The briefing ---
export type DayItemKind = "event" | "reminder" | "added";

export type BriefingItem = {
  id: string;
  kind: DayItemKind;
  title: string;
  detail: string | null;
  location: string | null;
  description: string | null;
  attendees: string[];
  when: string | null;
  end: string | null;
  source: string;
};

export type Briefing = {
  ok: true;
  date: string;
  items: BriefingItem[];
  counts: { events: number; reminders: number; added: number; total: number };
  calendar: { connected: boolean; message: string | null };
  doneAddedToday: number;
};

export async function buildBriefing(
  accountId: string,
  timeMin: string,
  timeMax: string,
  date: string,
): Promise<Briefing> {
  const items: BriefingItem[] = [];
  const cal = calendarStatus(accountId);
  let calendarMessage: string | null = null;
  if (cal.connected) {
    const ev = await listCalendarEvents(accountId, timeMin, timeMax);
    if (ev.ok) {
      for (const e of ev.events) {
        items.push({
          id: e.id,
          kind: "event",
          title: e.summary,
          detail: [e.location, e.description].filter(Boolean).join(" — ") || null,
          location: e.location || null,
          description: e.description || null,
          attendees: e.attendees || [],
          when: e.start || null,
          end: e.end || null,
          source: "Calendar",
        });
      }
    } else {
      calendarMessage = ev.message || "The calendar did not answer. Try again in a moment.";
    }
  } else {
    calendarMessage = cal.message || "Calendar is not connected yet.";
  }

  // Reminders due today or overdue, not done.
  let reminderCount = 0;
  for (const r of listReminders(accountId)) {
    if (r.done) continue;
    if (r.remindAt > timeMax) continue;
    reminderCount++;
    items.push({
      id: r.id,
      kind: "reminder",
      title: r.text,
      detail: null,
      location: null,
      description: null,
      attendees: [],
      when: r.remindAt,
      end: null,
      source: "Reminder",
    });
  }

  // Added items: open, due today or overdue, or with no due time.
  let addedCount = 0;
  const added = listDayItems(accountId).filter(
    (d) => d.status === "open" && (!d.due || d.due <= timeMax),
  );
  for (const d of added) {
    addedCount++;
    items.push({
      id: d.id,
      kind: "added",
      title: d.title,
      detail: d.detail,
      location: null,
      description: null,
      attendees: [],
      when: d.due,
      end: null,
      source: "Added today",
    });
  }

  // Time order; undated items last.
  const timeOf = (i: BriefingItem) => (i.when ? Date.parse(i.when) : Number.POSITIVE_INFINITY);
  items.sort((a, b) => timeOf(a) - timeOf(b));

  const doneAddedToday = listDayItems(accountId).filter(
    (d) => d.status === "done" && d.updated_at >= timeMin && d.updated_at <= timeMax,
  ).length;

  return {
    ok: true,
    date,
    items,
    counts: {
      events: items.filter((i) => i.kind === "event").length,
      reminders: reminderCount,
      added: addedCount,
      total: items.length,
    },
    calendar: { connected: cal.connected, message: calendarMessage },
    doneAddedToday,
  };
}

// --- Confirm: the ONLY call that edits anything ---
// The client calls this after the owner's tap on one item, and only
// then. Actions by kind:
//   event:    "keep" (no change), "cancel" (delete from the calendar),
//             "move" (rebook at start/end, then cancel the old one)
//   reminder: "done" (mark done), "move" (new time in `when`),
//             "skip" (no change)
//   added:    "done" (status done), "move" (new due in `when`),
//             "skip" (status skipped)
export async function confirmBriefingItem(
  accountId: string,
  kind: string,
  id: string,
  action: string,
  extra: Record<string, unknown>,
): Promise<
  | { ok: true; edited: string; message: string }
  | { ok: false; error: string; message: string }
> {
  const cleanId = String(id || "").trim();
  if (!cleanId) return { ok: false, error: "missing_fields", message: "An item id is needed." };

  if (kind === "event") {
    if (action === "keep") {
      return { ok: true, edited: "kept", message: "Kept as it is." };
    }
    if (action === "cancel") {
      const r = await cancelCalendarEvent(accountId, cleanId);
      if (!r.ok) return { ok: false, error: r.error, message: r.message };
      return { ok: true, edited: "cancelled", message: "Cancelled from the calendar." };
    }
    if (action === "move") {
      const start = String(extra.start || "").trim();
      const end = String(extra.end || "").trim();
      const title = String(extra.title || "").trim();
      if (!start || !end || !title) {
        return {
          ok: false,
          error: "missing_fields",
          message: "Moving an event needs a title, a new start time, and a new end time.",
        };
      }
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        return {
          ok: false,
          error: "bad_time",
          message: "Those start and end times don't work. The end has to be after the start.",
        };
      }
      const attendees = Array.isArray(extra.attendees)
        ? (extra.attendees as unknown[]).map((a) => String(a)).filter((a) => a.includes("@"))
        : [];
      // Book the new time FIRST: a failed booking leaves the old event
      // untouched. Only then cancel the old one.
      const booked = await bookCalendarEvent(accountId, {
        title,
        start,
        end,
        description: typeof extra.description === "string" ? extra.description : undefined,
        location: typeof extra.location === "string" ? extra.location : undefined,
        attendees,
      });
      if (!booked.ok) return { ok: false, error: booked.error, message: booked.message };
      const cancelled = await cancelCalendarEvent(accountId, cleanId);
      if (!cancelled.ok) {
        return {
          ok: false,
          error: cancelled.error,
          message:
            "The new time is booked, but the old event could not be cancelled. Both are on the calendar now — cancel the old one in the Calendar section.",
        };
      }
      return { ok: true, edited: "moved", message: "Moved to the new time." };
    }
    return { ok: false, error: "bad_action", message: "That is not a choice for a calendar event." };
  }

  if (kind === "reminder") {
    if (action === "done") {
      const r = markReminderDone(accountId, cleanId);
      if (!r) return { ok: false, error: "not_found", message: "That reminder is gone already." };
      return { ok: true, edited: "done", message: "Reminder done." };
    }
    if (action === "move") {
      const when = String(extra.when || "").trim();
      const whenMs = Date.parse(when);
      if (!when || Number.isNaN(whenMs)) {
        return { ok: false, error: "bad_time", message: "Moving a reminder needs a new time." };
      }
      if (!moveReminder(accountId, cleanId, new Date(whenMs).toISOString())) {
        return { ok: false, error: "not_found", message: "That reminder is gone already." };
      }
      return { ok: true, edited: "moved", message: "Reminder moved to the new time." };
    }
    if (action === "skip") {
      return { ok: true, edited: "skipped", message: "Skipped. Left as it is." };
    }
    return { ok: false, error: "bad_action", message: "That is not a choice for a reminder." };
  }

  if (kind === "added") {
    const now = new Date().toISOString();
    if (action === "done") {
      db.query(
        `UPDATE day_items SET status = 'done', updated_at = ? WHERE account_id = ? AND id = ?`,
      ).run(now, accountId, cleanId);
      return { ok: true, edited: "done", message: "Done." };
    }
    if (action === "move") {
      const when = String(extra.when || "").trim();
      const whenMs = Date.parse(when);
      if (!when || Number.isNaN(whenMs)) {
        return { ok: false, error: "bad_time", message: "Moving an item needs a new time." };
      }
      db.query(
        `UPDATE day_items SET due = ?, updated_at = ? WHERE account_id = ? AND id = ?`,
      ).run(new Date(whenMs).toISOString(), now, accountId, cleanId);
      return { ok: true, edited: "moved", message: "Moved to the new time." };
    }
    if (action === "skip") {
      db.query(
        `UPDATE day_items SET status = 'skipped', updated_at = ? WHERE account_id = ? AND id = ?`,
      ).run(now, accountId, cleanId);
      return { ok: true, edited: "skipped", message: "Skipped. Left as it is." };
    }
    return { ok: false, error: "bad_action", message: "That is not a choice for an added item." };
  }

  return { ok: false, error: "bad_kind", message: "That is not a kind of day item." };
}

// --- Route handler ---
// The coordinator mounts this from server.ts handleApi before the final
// 404: `const day = await handleDayApi(req, path); if (day) return day;`.
// It returns null for paths it does not own.
export async function handleDayApi(req: Request, path: string): Promise<Response | null> {
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/day/briefing?timeMin&timeMax&date — today's items, in time
  // order. Read-only: nothing is edited by this call. The client sends
  // the day window in its own local time; the server never guesses the
  // owner's timezone.
  if (path === "/api/day/briefing" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const timeMin = (url.searchParams.get("timeMin") || "").trim();
    const timeMax = (url.searchParams.get("timeMax") || "").trim();
    const date = (url.searchParams.get("date") || "").trim();
    if (!timeMin || !timeMax || !date) {
      return bad("timeMin, timeMax, and date are required", 400);
    }
    if (Number.isNaN(Date.parse(timeMin)) || Number.isNaN(Date.parse(timeMax))) {
      return bad("timeMin and timeMax must be dates", 400);
    }
    return json(await buildBriefing(accountId, timeMin, timeMax, date));
  }

  // GET /api/day/items — the tracked items added during the day.
  if (path === "/api/day/items" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, items: listDayItems(accountId) });
  }

  // POST /api/day/items — add an item to today's plan. Body:
  // { accountId, title, detail?, due? }.
  if (path === "/api/day/items" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const title = String(body.title || "").trim();
    const detail = String(body.detail || "").trim() || null;
    const dueRaw = String(body.due || "").trim() || null;
    if (!title) return bad("title required", 400);
    if (title.length > 200) return bad("title too long", 400);
    if (detail && detail.length > 500) return bad("detail too long", 400);
    let due: string | null = null;
    if (dueRaw) {
      const dueMs = Date.parse(dueRaw);
      if (Number.isNaN(dueMs)) return bad("due must be a date", 400);
      due = new Date(dueMs).toISOString();
    }
    const item = createDayItem(accountId, title, detail, due);
    return json({ ok: true, item }, 201);
  }

  // POST /api/day/confirm — confirm one briefing item, then edit it.
  // Body: { accountId, kind, id, action, start?, end?, when?, title?,
  // description?, location?, attendees? }. This is the ONLY call that
  // edits anything in this module.
  if (path === "/api/day/confirm" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const kind = String(body.kind || "").trim();
    const id = String(body.id || "").trim();
    const action = String(body.action || "").trim();
    if (!kind || !id || !action) return bad("kind, id, and action are required", 400);
    const r = await confirmBriefingItem(accountId, kind, id, action, body as Record<string, unknown>);
    if (!r.ok) return json(r, 400);
    return json(r);
  }

  return null;
}
