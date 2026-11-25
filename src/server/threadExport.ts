// Conversation export: a thread as a downloadable Markdown transcript.
// The owner can import memories into Prism; this is the way back out —
// their own conversation with a Photon (or an Atom), in order, with
// speaker labels, in a plain file they keep.

export type ExportMessage = {
  role: "user" | "assistant";
  content: string;
  created_at?: string;
};

export function threadExportFilename(photon: string, exportedAt: Date = new Date()): string {
  const safeName = photon.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "conversation";
  const day = exportedAt.toISOString().slice(0, 10);
  return `prism-${safeName}-conversation-${day}.md`;
}

export function buildThreadExport(
  photon: string,
  messages: ExportMessage[],
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [
    `# Conversation with ${photon}`,
    "",
    `Exported: ${exportedAt.toISOString()}`,
    "",
    `${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
    "",
    "---",
    "",
  ];
  for (const m of messages) {
    const speaker = m.role === "user" ? "You" : photon;
    lines.push(`**${speaker}:** ${m.content}`, "");
  }
  return lines.join("\n");
}

export function fullExportFilename(exportedAt: Date = new Date()): string {
  const day = exportedAt.toISOString().slice(0, 10);
  return `prism-all-conversations-${day}.md`;
}

// Every conversation the account holds, in one Markdown file: a
// heading, the export date, a total count, then each conversation in
// full under its own heading, reusing the single-thread builder's
// body so the two exports read the same way.
export function buildFullExport(
  sections: { photon: string; messages: ExportMessage[] }[],
  exportedAt: Date = new Date(),
): string {
  const total = sections.reduce((n, s) => n + s.messages.length, 0);
  const lines: string[] = [
    "# All your Prism conversations",
    "",
    `Exported: ${exportedAt.toISOString()}`,
    "",
    `${sections.length} ${sections.length === 1 ? "conversation" : "conversations"} · ${total} ${total === 1 ? "message" : "messages"}`,
    "",
  ];
  for (const s of sections) {
    lines.push("---", "", `## Conversation with ${s.photon}`, "");
    for (const m of s.messages) {
      const speaker = m.role === "user" ? "You" : s.photon;
      lines.push(`**${speaker}:** ${m.content}`, "");
    }
  }
  return lines.join("\n");
}
