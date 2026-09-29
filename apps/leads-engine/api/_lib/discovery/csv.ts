/** RFC-4180 compatible parser kept dependency-free for Vercel functions. */
export function parseCsvRecords(input: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift()?.map((value) => value.trim()) ?? [];
  if (!headers.length) return [];
  return rows
    .filter((values) => values.some((value) => value.trim() !== ""))
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ),
    );
}

function key(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function field(
  row: Record<string, unknown>,
  ...aliases: string[]
): string | null {
  const wanted = new Set(aliases.map(key));
  for (const [name, value] of Object.entries(row)) {
    if (!wanted.has(key(name)) || value === null || value === undefined)
      continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function numberField(
  row: Record<string, unknown>,
  ...aliases: string[]
): number | null {
  const value = field(row, ...aliases);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizedIdentity(
  name: string | null,
  address: string | null,
): string {
  const normalize = (value: string | null) =>
    (value ?? "")
      .toLowerCase()
      .replace(/\b(inc|ltd|limited|corp|corporation)\b\.?/g, "")
      .replace(/[^a-z0-9]/g, "");
  return `${normalize(name)}:${normalize(address)}`;
}
