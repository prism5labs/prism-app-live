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
