/**
 * JSONB safety for scraped content.
 *
 * PostgreSQL jsonb rejects two things JSON.stringify happily emits:
 * the escape for U+0000, and escapes for unpaired UTF-16
 * surrogates ( scraped HTML can contain both — NUL bytes from sloppy
 * CMS output, and lone surrogates when a text slice lands between a
 * surrogate pair). One such character anywhere in the persist
 * payload failed the whole job with "unsupported Unicode escape
 * sequence" — an error the retry classifier treated as transient,
 * so affected clinics burned their attempts and dead-lettered.
 */

/** Strip U+0000 and replace unpaired surrogates with U+FFFD. */
export function sanitizeForJsonb(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += text[i];
    }
  }
  return out;
}

/** Recursively sanitize every string in a JSON-shaped payload. */
export function sanitizePayloadStrings<T>(value: T): T {
  if (typeof value === "string") return sanitizeForJsonb(value) as T;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayloadStrings(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Keys too: a generated property name carrying a NUL or a
      // lone surrogate would poison the JSON just as a value does.
      out[sanitizeForJsonb(key)] = sanitizePayloadStrings(entry);
    }
    return out as T;
  }
  return value;
}
