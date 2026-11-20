// HTML-entity decoding for plain text pulled out of HTML mail.
//
// Gmail's snippet and the HTML bodies of mail arrive with entities
// still in them: a snippet can carry a literal &#39;, and an HTML-only
// body can carry &rsquo; or &#8217;. The client's esc() then escapes
// the & a second time, so the owner sees &#39; instead of an
// apostrophe. Decode once, here, where the text is produced.
// Plain-text parts are already plain text and are never passed
// through this.
//
// Single pass: an entity formed by a replacement is not re-scanned,
// so "&amp;#39;" decodes to the literal "&#39;", not to an apostrophe.
// Unknown named entities are left alone rather than guessed at.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  micro: "µ",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const n =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(n) && n > 0 && n <= 0x10ffff) {
        try {
          return String.fromCodePoint(n);
        } catch {
          return m;
        }
      }
      return m;
    }
    const v = NAMED[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}
