// Email reader regression test: the reader must fit a phone, and mail
// text must arrive with its entities decoded.
//
// Bug 1 (Nov 19, 2026): the reader's sender line carried an unbreakable
// email address with no overflow-wrap, so at narrower viewports and
// larger text sizes its content ran wider than the sheet; the sheet's
// overflow-y: auto turned overflow-x into auto, and the line was
// clipped behind a sideways scrollbar instead of wrapping.
// Bug 2: Gmail's snippet (and HTML-only bodies) arrive with entities
// still in them; the client's esc() escaped the & a second time, so
// the list showed a literal &#39; instead of an apostrophe.
//
// Run: bun scripts/test-email-reader.ts (no server, no network).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeHtmlEntities } from "../src/server/htmlText";

const ROOT = join(import.meta.dir, "..");

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
const eq = (name: string, got: string, want: string) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// --- Entity decoding: one pass, at the boundary where text is made ---
eq("decimal entity decodes", decodeHtmlEntities("You&#39;re all set"), "You're all set");
eq("hex entity decodes", decodeHtmlEntities("You&#x27;re all set"), "You're all set");
eq("named curly quote decodes", decodeHtmlEntities("the computer\u2019s"), "the computer\u2019s");
eq("rsquo decodes", decodeHtmlEntities("it&rsquo;s"), "it’s");
eq("decimal curly quote decodes", decodeHtmlEntities("it&#8217;s"), "it’s");
eq("amp decodes", decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
eq("lt/gt decode", decodeHtmlEntities("&lt;tag&gt;"), "<tag>");
eq("nbsp becomes a space", decodeHtmlEntities("a&nbsp;b"), "a b");
eq("single pass only: &amp;#39; stays literal", decodeHtmlEntities("&amp;#39;"), "&#39;");
eq("unknown entity left alone", decodeHtmlEntities("a &nosuch; b"), "a &nosuch; b");
eq("plain text untouched", decodeHtmlEntities("Fish & Chips, no entities"), "Fish & Chips, no entities");
eq("out-of-range numeric left alone", decodeHtmlEntities("&#99999999;"), "&#99999999;");

// --- The stylesheet carries the wrapping rules that keep the reader
// inside the viewport, and the sheet can never grow a sideways bar ---
const css = readFileSync(join(ROOT, "public", "styles.css"), "utf8");
const ruleHas = (selector: string, prop: string) => {
  const i = css.indexOf(selector);
  if (i < 0) return false;
  const block = css.slice(i, css.indexOf("}", i));
  return block.includes(prop);
};
check(".card-kind wraps anywhere", ruleHas(".card-kind", "overflow-wrap: anywhere"));
check(".card-title wraps anywhere", ruleHas(".card-title", "overflow-wrap: anywhere"));
check(".email-body wraps anywhere", ruleHas(".email-body", "overflow-wrap: anywhere"));
check("list rows wrap anywhere", ruleHas(".email-row .inbox-subject", "overflow-wrap: anywhere"));
check(".card-sheet clips horizontal overflow", ruleHas(".card-sheet", "overflow-x: clip"));
check(".card-sheet still scrolls vertically", ruleHas(".card-sheet", "overflow-y: auto"));

// --- The server decodes where the text is produced, not in the client ---
const gmail = readFileSync(join(ROOT, "src", "server", "gmail.ts"), "utf8");
check("gmail list decodes the snippet", gmail.includes("decodeHtmlEntities(d.snippet"));
check("gmail html fallback decodes entities", gmail.includes("decodeHtmlEntities(stripped)"));
check("gmail keeps plain-text parts untouched", gmail.includes('if (plain) return plain;'));
const outlook = readFileSync(join(ROOT, "src", "server", "outlook.ts"), "utf8");
check("outlook html fallback decodes entities", outlook.includes("decodeHtmlEntities("));
check("outlook leaves bodyPreview alone", !outlook.includes("decodeHtmlEntities(m.bodyPreview"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
