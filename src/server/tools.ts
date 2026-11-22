// Photon + Atom tool use (READ + DRAFT ONLY).
//
// Tools exposed to the Anthropic brain so a Photon or Atom can, in chat:
// read the owner's inbox, read one email, save a Gmail draft, read the
// calendar / free-busy, search and read Drive, and list / add reminders.
//
// By design there is NO send tool and NO booking/cancelling tool:
// gmail.sendEmail, gmail.sendFromAny, google.bookCalendarEvent and
// google.cancelCalendarEvent are never imported or exposed here.
// Sending and booking stay the owner's own tap in the app.
//
// Every executor result is a JSON string (the Anthropic tool_result
// content). Oversized results are truncated with a plain note, never
// silently cut.

import {
  listInbox,
  getMessage,
  saveDraft,
  connectedLabels,
  isValidGmailLabel,
  type GmailLabel,
} from "./gmail";
import {
  listCalendarEvents,
  freeBusy,
  searchDrive,
  readDriveFile,
  calendarStatus,
  driveStatus,
} from "./google";
import { listReminders, createReminder } from "./proactive";

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

const LABEL_PROP = {
  type: "string",
  description:
    "Which connected Gmail account to use, by its label (for example \"personal\"). Optional: when omitted, the first connected Gmail account is used.",
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_inbox",
    description:
      "List recent messages in the owner's Gmail inbox (at most 10), with sender, subject, date, snippet, and unread flag. Read-only.",
    input_schema: {
      type: "object",
      properties: { label: LABEL_PROP },
    },
  },
  {
    name: "read_email",
    description: "Read one Gmail message in full by its message id. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        label: LABEL_PROP,
        id: { type: "string", description: "The Gmail message id, from list_inbox." },
      },
      required: ["id"],
    },
  },
  {
    name: "save_draft",
    description:
      "Save a draft email in the owner's Gmail drafts. This does NOT send anything; the owner reviews and sends it themselves in the app.",
    input_schema: {
      type: "object",
      properties: {
        label: LABEL_PROP,
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Subject line (may be empty)." },
        body: { type: "string", description: "The full draft text." },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "list_calendar_events",
    description:
      "List events on the owner's primary Google Calendar in a time window. Defaults to now through 7 days out. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Window start, ISO 8601 date-time. Optional." },
        timeMax: { type: "string", description: "Window end, ISO 8601 date-time. Optional." },
      },
    },
  },
  {
    name: "calendar_freebusy",
    description:
      "List the busy times on the owner's primary Google Calendar in a time window, so a free time can be found. Defaults to now through 7 days out. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "Window start, ISO 8601 date-time. Optional." },
        timeMax: { type: "string", description: "Window end, ISO 8601 date-time. Optional." },
      },
    },
  },
  {
    name: "search_drive",
    description:
      "Search the owner's Google Drive by file name, or list the most recently modified files when no query is given. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name search text. Optional." },
      },
    },
  },
  {
    name: "read_drive_file",
    description:
      "Read one Google Drive file as text by its file id (from search_drive). Some file types cannot be read as text; the result says so plainly. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        fileId: { type: "string", description: "The Drive file id, from search_drive." },
      },
      required: ["fileId"],
    },
  },
  {
    name: "list_reminders",
    description: "List the owner's reminders, soonest first. Read-only.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_reminder",
    description: "Add a reminder for the owner, to surface when it comes due.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the owner about." },
        remindAt: { type: "string", description: "When it is due, ISO 8601 date-time." },
      },
      required: ["text", "remindAt"],
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

// --- Connection state (for the system-prompt tools block) -------------

export type ToolConnectionState = {
  gmailAccounts: { label: string; email: string }[];
  calendarConnected: boolean;
  calendarEmail: string | null;
  driveConnected: boolean;
  driveEmail: string | null;
};

export function getToolConnectionState(accountId: string): ToolConnectionState {
  const cal = calendarStatus(accountId);
  const drv = driveStatus(accountId);
  return {
    gmailAccounts: connectedLabels(accountId).map((c) => ({ label: c.label, email: c.email })),
    calendarConnected: cal.connected === true,
    calendarEmail: cal.email || null,
    driveConnected: drv.connected === true,
    driveEmail: drv.email || null,
  };
}

// --- Helpers -----------------------------------------------------------

const MAX_MESSAGE_CHARS = 8000;
const MAX_DRIVE_CHARS = 8000;
const MAX_SNIPPET_CHARS = 300;

function cap(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

function result(obj: unknown): string {
  return JSON.stringify(obj);
}

function fail(error: string, message: string): string {
  return result({ ok: false, error, message });
}

function notConnected(what: string): string {
  return fail(
    "not_connected",
    `${what} is not connected for this account. Tell the owner plainly and point them to the Inboxes / Connected tab in the app to connect it. Do not invent any ${what} content.`,
  );
}

function str(input: any, key: string): string {
  return typeof input?.[key] === "string" ? input[key].trim() : "";
}

function validIso(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

// Resolve the Gmail label for a tool call: the model's pick when it is a
// valid, connected label; otherwise the first connected account. Null
// (with a ready-made result string) when nothing is connected or the
// label is not usable.
function resolveLabel(
  accountId: string,
  input: any,
): { label: GmailLabel } | { errorResult: string } {
  const connected = connectedLabels(accountId);
  if (!connected.length) return { errorResult: notConnected("Gmail") };
  const wanted = str(input, "label");
  if (wanted) {
    if (!isValidGmailLabel(wanted)) {
      return { errorResult: fail("bad_label", `"${wanted}" is not a valid Gmail account label. Connected labels: ${connected.map((c) => c.label).join(", ")}.`) };
    }
    if (!connected.some((c) => c.label === wanted)) {
      return { errorResult: fail("not_connected", `Gmail account "${wanted}" is not connected. Connected labels: ${connected.map((c) => c.label).join(", ")}.`) };
    }
    return { label: wanted as GmailLabel };
  }
  return { label: connected[0].label };
}

// --- Executor ----------------------------------------------------------

export async function executeTool(
  accountId: string,
  name: string,
  input: any,
): Promise<string> {
  try {
    switch (name) {
      case "list_inbox": {
        const r = resolveLabel(accountId, input);
        if ("errorResult" in r) return r.errorResult;
        const inbox = await listInbox(accountId, r.label, 10);
        if (!inbox.connected) return notConnected("Gmail");
        return result({
          ok: true,
          label: r.label,
          email: inbox.email || null,
          unreadCount: typeof inbox.unreadCount === "number" ? inbox.unreadCount : null,
          messages: inbox.messages.slice(0, 10).map((m) => ({
            id: m.id,
            from: m.from,
            subject: m.subject,
            date: m.date,
            snippet: cap(m.snippet || "", MAX_SNIPPET_CHARS).text,
            unread: m.unread ?? null,
          })),
          ...(inbox.error ? { error: inbox.error } : {}),
        });
      }
      case "read_email": {
        const id = str(input, "id");
        if (!id) return fail("missing_input", "read_email needs a message id.");
        const r = resolveLabel(accountId, input);
        if ("errorResult" in r) return r.errorResult;
        const msg = await getMessage(accountId, r.label, id);
        if (!msg.ok) {
          if (msg.error === "not_connected") return notConnected("Gmail");
          return fail(msg.error || "message_failed", "That message could not be read.");
        }
        const body = cap(msg.body || "", MAX_MESSAGE_CHARS);
        return result({
          ok: true,
          label: r.label,
          id: msg.id,
          from: msg.from,
          subject: msg.subject,
          date: msg.date,
          body: body.text,
          ...(body.truncated ? { truncated: true, note: "The message body was truncated here; the rest is not shown." } : {}),
        });
      }
      case "save_draft": {
        const to = str(input, "to");
        const body = typeof input?.body === "string" ? input.body : "";
        const subject = typeof input?.subject === "string" ? input.subject : "";
        if (!to || !body.trim()) return fail("missing_input", "save_draft needs a recipient (to) and a body.");
        const r = resolveLabel(accountId, input);
        if ("errorResult" in r) return r.errorResult;
        const draft = await saveDraft(accountId, r.label, to, subject, body);
        if (!draft.ok) {
          if (draft.error === "not_connected") return notConnected("Gmail");
          return fail(draft.error || "draft_failed", "The draft could not be saved.");
        }
        return result({ ok: true, label: r.label, draftId: draft.draftId, note: "Draft saved. Nothing was sent; the owner sends it themselves." });
      }
      case "list_calendar_events": {
        const timeMin = str(input, "timeMin");
        const timeMax = str(input, "timeMax");
        if (timeMin && !validIso(timeMin)) return fail("bad_time", "timeMin is not a valid ISO date-time.");
        if (timeMax && !validIso(timeMax)) return fail("bad_time", "timeMax is not a valid ISO date-time.");
        const r = await listCalendarEvents(accountId, timeMin || undefined, timeMax || undefined);
        if (!r.ok) {
          if (r.error === "not_connected") return notConnected("Calendar");
          return fail(r.error, r.message);
        }
        return result({
          ok: true,
          connected: r.connected,
          email: r.email || null,
          events: r.events.slice(0, 50).map((e) => ({
            ...e,
            ...(e.description ? { description: cap(e.description, 500).text } : {}),
          })),
        });
      }
      case "calendar_freebusy": {
        const timeMin = str(input, "timeMin");
        const timeMax = str(input, "timeMax");
        if (timeMin && !validIso(timeMin)) return fail("bad_time", "timeMin is not a valid ISO date-time.");
        if (timeMax && !validIso(timeMax)) return fail("bad_time", "timeMax is not a valid ISO date-time.");
        const r = await freeBusy(accountId, timeMin || undefined, timeMax || undefined);
        if (!r.ok) {
          if (r.error === "not_connected") return notConnected("Calendar");
          return fail(r.error, r.message);
        }
        return result({ ok: true, connected: r.connected, email: r.email || null, busy: r.busy });
      }
      case "search_drive": {
        const q = str(input, "query") || str(input, "q");
        const r = await searchDrive(accountId, q || undefined);
        if (!r.ok) {
          if (r.error === "not_connected") return notConnected("Drive");
          return fail(r.error, r.message);
        }
        return result({ ok: true, connected: r.connected, email: r.email || null, files: r.files.slice(0, 20) });
      }
      case "read_drive_file": {
        const fileId = str(input, "fileId") || str(input, "id");
        if (!fileId) return fail("missing_input", "read_drive_file needs a fileId.");
        const r = await readDriveFile(accountId, fileId);
        if (!r.ok) {
          if (r.error === "not_connected") return notConnected("Drive");
          return fail(r.error, r.message);
        }
        if (!r.readable) return result({ ok: true, readable: false, file: r.file, message: r.message });
        const content = cap(r.content, MAX_DRIVE_CHARS);
        return result({
          ok: true,
          readable: true,
          file: r.file,
          content: content.text,
          truncated: r.truncated || content.truncated,
          ...(r.truncated || content.truncated ? { note: "The file content was truncated here; the rest is not shown." } : {}),
        });
      }
      case "list_reminders": {
        const reminders = listReminders(accountId);
        return result({ ok: true, reminders: reminders.slice(0, 100) });
      }
      case "add_reminder": {
        const text = str(input, "text");
        const remindAt = str(input, "remindAt") || str(input, "remind_at");
        if (!text) return fail("missing_input", "add_reminder needs the reminder text.");
        if (text.length > 500) return fail("missing_input", "The reminder text is too long (500 characters at most).");
        if (!validIso(remindAt)) return fail("bad_time", "add_reminder needs remindAt as a valid ISO date-time.");
        const reminder = createReminder(accountId, text, new Date(remindAt).toISOString());
        return result({ ok: true, reminder });
      }
      default:
        return fail("unknown_tool", `There is no tool named "${name}".`);
    }
  } catch (e) {
    console.error(`tool ${name} failed:`, e);
    return fail("tool_failed", "That tool call failed. Say so plainly instead of inventing a result.");
  }
}
