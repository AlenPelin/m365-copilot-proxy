/**
 * M365 web-UI markup that the models leak into their prose answers, and that an
 * API client would show raw. Used on text replies on both the OpenAI path
 * (handler.ts, tool mode) and the Anthropic path (anthropic.ts). Never on tool
 * inputs: a command or file body may legitimately contain `<File>` (e.g. WiX XML).
 */

/** Citation markers (`citeturn0file1`, shown as "citeturn0file1").
 *  Private-use characters, so they are never real content, code included. */
const CITATION = /[^]*/g;

/** File chips. The web client renders `<File>notlar.docx</File>` as a chip, and the
 *  GPT models write that markup into answers: 58 times in 245 distinct final pi
 *  answers (upstream PR #70), plus `<document>`, `<Files>`, `<file>`, `<FILE>` and
 *  "< File>". A tag pair is needed, so a bare `<stdio.h>` is untouched. */
const FILE_CHIP = /<\s*(file|files|document)\s*>([^<>\n]{1,200}?)<\/\s*\1\s*>/gi;

/** Fenced code blocks and inline code: left as they are (an example of the markup). */
const CODE = /(```[\s\S]*?```|`[^`\n]+`)/;

/** Return `text` with citation markers dropped and file chips as the bare file
 *  name; outside code, trailing spaces a dropped marker leaves are trimmed. */
export function stripM365Markup(text: string): string {
  return text
    .replace(CITATION, "")
    .split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(FILE_CHIP, "$2").replace(/[ \t]+(?=\r?\n)/g, "")))
    .join("")
    .replace(/[ \t]+$/, "");
}
