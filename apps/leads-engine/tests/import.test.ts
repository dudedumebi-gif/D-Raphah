import { describe, expect, it } from "vitest";
import {
  dedupeRows,
  DEFAULT_IMPORT_BUSINESS_PURPOSE,
  mapRowToSourceInput,
  normalizeSourceUrl,
  parseSourceCsv,
} from "../api/_lib/source-import";

describe("normalizeSourceUrl", () => {
  it("lowercases, strips www, default ports, fragments and trailing slashes", () => {
    expect(normalizeSourceUrl("HTTPS://WWW.Example.com/")).toBe(
      "https://example.com",
    );
    expect(normalizeSourceUrl("https://example.com:443/a/b/")).toBe(
      "https://example.com/a/b",
    );
    expect(normalizeSourceUrl("http://example.com:80/x#frag")).toBe(
      "http://example.com/x",
    );
  });

  it("keeps the path and query string", () => {
    expect(normalizeSourceUrl("https://example.com/shop?b=2")).toBe(
      "https://example.com/shop?b=2",
    );
    expect(normalizeSourceUrl("https://example.com/deep/page")).toBe(
      "https://example.com/deep/page",
    );
  });

  it("keeps non-default ports and subdomains", () => {
    expect(normalizeSourceUrl("https://example.com:8443/x")).toBe(
      "https://example.com:8443/x",
    );
    expect(normalizeSourceUrl("https://shop.example.com/")).toBe(
      "https://shop.example.com",
    );
  });

  it("rejects non-http(s) URLs, credentials and garbage", () => {
    expect(() => normalizeSourceUrl("ftp://example.com/x")).toThrow(/HTTP/i);
    expect(() => normalizeSourceUrl("file:///etc/passwd")).toThrow(/HTTP/i);
    expect(() => normalizeSourceUrl("https://user:pw@example.com/")).toThrow(
      /credential/i,
    );
    expect(() => normalizeSourceUrl("not a url")).toThrow(/invalid/i);
    expect(() => normalizeSourceUrl("")).toThrow();
  });
});

describe("parseSourceCsv", () => {
  it("parses a simple header and rows", () => {
    const result = parseSourceCsv(
      "name,website,collection_method,business_purpose\n" +
        "Acme,https://acme.com,static_html,We collect public pricing pages.\n",
    );
    expect(result.error).toBeNull();
    expect(result.rows).toEqual([
      {
        name: "Acme",
        website: "https://acme.com",
        collectionMethod: "static_html",
        businessPurpose: "We collect public pricing pages.",
      },
    ]);
  });

  it("handles quoted fields with commas, CRLF and escaped quotes", () => {
    const result = parseSourceCsv(
      'name,website\r\n"Acme, Inc.",https://acme.com\r\n"He said ""hi""",https://hi.com\r\n',
    );
    expect(result.error).toBeNull();
    expect(result.rows.map((r) => r.name)).toEqual([
      "Acme, Inc.",
      'He said "hi"',
    ]);
  });

  it("handles quoted fields containing newlines", () => {
    const result = parseSourceCsv(
      'name,website,business_purpose\nAcme,https://acme.com,"line one\nline two"\n',
    );
    expect(result.error).toBeNull();
    expect(result.rows[0].businessPurpose).toBe("line one\nline two");
  });

  it("matches headers case-insensitively and accepts aliases", () => {
    const result = parseSourceCsv(
      "Name,BASE_URL\nAcme,https://acme.com\nBeta,https://beta.com\n",
    );
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].website).toBe("https://acme.com");
  });

  it("accepts the url alias and drops unknown collection methods", () => {
    const result = parseSourceCsv(
      "name,url,method\nAcme,https://acme.com,sorcery\n",
    );
    expect(result.error).toBeNull();
    expect(result.rows[0].website).toBe("https://acme.com");
    expect(result.rows[0].collectionMethod).toBeUndefined();
  });

  it("surfaces the first parse error clearly", () => {
    expect(parseSourceCsv("").error).toMatch(/empty/i);
    expect(parseSourceCsv("name\nAcme\n").error).toMatch(/website/i);
    expect(parseSourceCsv("website\nhttps://acme.com\n").error).toMatch(
      /'name'/,
    );
    expect(parseSourceCsv('name,website\n"Acme,https://acme.com\n').error).toMatch(
      /quote/i,
    );
  });

  it("skips blank lines", () => {
    const result = parseSourceCsv(
      "name,website\n\nAcme,https://acme.com\n\n",
    );
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
  });
});

describe("dedupeRows", () => {
  it("keeps first occurrences and skips workspace and in-file duplicates", () => {
    const rows = [
      { index: 0, row: { name: "A", website: "https://a.com" } },
      { index: 1, row: { name: "B", website: "https://www.b.com/" } },
      { index: 2, row: { name: "B2", website: "https://b.com" } },
      { index: 3, row: { name: "Old", website: "https://old.com" } },
      { index: 4, row: { name: "Bad", website: "ftp://bad.com" } },
    ];
    const { unique, skipped } = dedupeRows(rows, ["https://old.com"]);
    expect(unique.map((r) => r.index)).toEqual([0, 1]);
    expect(skipped.map((s) => s.index)).toEqual([2, 3, 4]);
    expect(skipped[0].reason).toMatch(/repeated/i);
    expect(skipped[1].reason).toMatch(/already exists/i);
    expect(skipped[2].reason).toMatch(/invalid_url/i);
  });

  it("treats http/https and www variants as the same source", () => {
    const rows = [
      { index: 0, row: { name: "A", website: "http://example.com" } },
      { index: 1, row: { name: "B", website: "https://www.example.com/" } },
    ];
    const { unique, skipped } = dedupeRows(rows, []);
    expect(unique).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });
});

describe("mapRowToSourceInput", () => {
  it("builds a schema-shaped input with UI-matching defaults", () => {
    const input = mapRowToSourceInput(
      { name: "  Acme  ", website: "https://www.acme.com/" },
      "ops@example.com",
    );
    expect(input).toMatchObject({
      name: "Acme",
      baseUrl: "https://acme.com",
      collectionMethod: "static_html",
      businessPurpose: DEFAULT_IMPORT_BUSINESS_PURPOSE,
      allowedDomains: ["acme.com"],
      allowlistPaths: ["/*"],
      denylistPaths: ["/login*", "/account*", "/admin*"],
      contactEmail: "ops@example.com",
    });
  });

  it("keeps an explicit collection method and a long-enough purpose", () => {
    const input = mapRowToSourceInput(
      {
        name: "Acme",
        website: "https://acme.com",
        collectionMethod: "rss",
        businessPurpose: "Track public job postings for hiring signals.",
      },
      "ops@example.com",
    );
    expect(input.collectionMethod).toBe("rss");
    expect(input.businessPurpose).toBe(
      "Track public job postings for hiring signals.",
    );
  });

  it("falls back to the default purpose when the row purpose is too short", () => {
    const input = mapRowToSourceInput(
      { name: "Acme", website: "https://acme.com", businessPurpose: "leads" },
      "ops@example.com",
    );
    expect(input.businessPurpose).toBe(DEFAULT_IMPORT_BUSINESS_PURPOSE);
  });

  it("rejects rows with unusable website URLs", () => {
    expect(() =>
      mapRowToSourceInput({ name: "Acme", website: "notaurl" }, "ops@example.com"),
    ).toThrow(/invalid/i);
    expect(() =>
      mapRowToSourceInput(
        { name: "Acme", website: "ftp://acme.com" },
        "ops@example.com",
      ),
    ).toThrow(/HTTP/i);
  });
});
