import { describe, expect, it } from "vitest";
import { detectSignals, scoreSignals } from "../api/_lib/domain";
import {
  collectUrl,
  detectHiringRoles,
  detectJobBoards,
  discoverJobPageUrls,
  fingerprintEvidenceLines,
  fingerprintPage,
  MAX_JOB_PAGES,
  type CollectionPolicy,
} from "../api/_lib/collection";

const testPolicy: CollectionPolicy = {
  allowedDomains: ["example.com"],
  allowlistPaths: [],
  denylistPaths: [],
  userAgent: "RaphahTestBot/1.0",
  contactEmail: "ops@example.com",
  rateLimitRps: 10,
  maxBytes: 1_000_000,
  timeoutMs: 5000,
  respectRobots: false,
  collectionMethod: "static_html",
};

function htmlResponse(
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
  });
}

interface MockFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  calls: string[];
}

/** Routes by URL; no live network. Records every requested URL. */
function createMockFetcher(
  handler: (url: URL, init?: RequestInit) => Response,
): MockFetch {
  const calls: string[] = [];
  const fn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    calls.push(url.toString());
    return handler(url, init);
  }) as MockFetch;
  fn.calls = calls;
  return fn;
}

const HOMEPAGE_HTML = `<!DOCTYPE html>
<html><head>
<title>Acme Plumbing</title>
<meta name="generator" content="WordPress 6.4">
<script src="https://js.intercomcdn.com/widget.js"></script>
<script src="https://assets.calendly.com/assets/external/widget.js"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=GA-1"></script>
</head><body>
<h1>Acme Plumbing</h1>
<p>Call us to book an appointment.</p>
<nav>
<a href="/careers">Careers</a>
<a href="/jobs">Jobs</a>
<a href="/join-us">Join us</a>
<a href="https://boards.greenhouse.io/acme">View openings</a>
<a href="mailto:jobs@example.com">Email us</a>
</nav>
</body></html>`;

const CAREERS_HTML = `<!DOCTYPE html>
<html><head><title>Careers at Acme</title>
<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
</head><body>
<h1>Join our team</h1>
<p>We are hiring a receptionist and a data entry clerk for the front office.</p>
<iframe src="https://boards.lever.co/acme"></iframe>
</body></html>`;

const JOBS_HTML = `<!DOCTYPE html>
<html><head><title>Jobs</title></head><body>
<h1>Open roles</h1><p>No openings right now. Check back soon.</p>
</body></html>`;

describe("fingerprintPage", () => {
  it("captures meta generator, selected headers, and script srcs", () => {
    const fingerprint = fingerprintPage(HOMEPAGE_HTML, {
      server: "Apache",
      "X-Powered-By": "PHP/7.4",
      "content-type": "text/html",
    });
    expect(fingerprint.metaGenerator).toBe("WordPress 6.4");
    expect(fingerprint.headers).toEqual({
      server: "Apache",
      "x-powered-by": "PHP/7.4",
    });
    expect(fingerprint.scriptSrcs).toEqual([
      "https://js.intercomcdn.com/widget.js",
      "https://assets.calendly.com/assets/external/widget.js",
      "https://www.googletagmanager.com/gtag/js?id=GA-1",
    ]);
  });

  it("reads generator when content precedes name", () => {
    const fingerprint = fingerprintPage(
      `<meta content="Wix.com Website Builder" name="generator">`,
      {},
    );
    expect(fingerprint.metaGenerator).toBe("Wix.com Website Builder");
  });

  it("returns null generator and empty lists when nothing is present", () => {
    const fingerprint = fingerprintPage("<html><body>plain</body></html>", {});
    expect(fingerprint.metaGenerator).toBeNull();
    expect(fingerprint.headers).toEqual({});
    expect(fingerprint.scriptSrcs).toEqual([]);
  });
});

describe("fingerprintEvidenceLines", () => {
  it("renders marked lines that cite the concrete artifact", () => {
    const lines = fingerprintEvidenceLines({
      metaGenerator: "WordPress 6.4",
      headers: { "x-powered-by": "PHP/7.4" },
      scriptSrcs: ["https://js.intercomcdn.com/widget.js"],
    });
    expect(lines).toEqual([
      "[tech-fingerprint] meta-generator: WordPress 6.4",
      "[tech-fingerprint] header: x-powered-by: PHP/7.4",
      "[tech-fingerprint] script-src: https://js.intercomcdn.com/widget.js",
    ]);
  });
});

describe("discoverJobPageUrls", () => {
  it("finds same-host careers/jobs links, dedupes, and caps the page budget", () => {
    const urls = discoverJobPageUrls(HOMEPAGE_HTML, "https://example.com/");
    expect(urls).toEqual([
      "https://example.com/careers",
      "https://example.com/jobs",
    ]);
    expect(urls.length).toBeLessThanOrEqual(MAX_JOB_PAGES);
  });

  it("matches on anchor text when the href path is generic", () => {
    const urls = discoverJobPageUrls(
      `<a href="/team">Join us</a>`,
      "https://example.com/",
    );
    expect(urls).toEqual(["https://example.com/team"]);
  });

  it("skips external, mailto, and anchor-only links", () => {
    const urls = discoverJobPageUrls(
      `<a href="https://boards.greenhouse.io/acme">x</a>` +
        `<a href="mailto:jobs@example.com">x</a>` +
        `<a href="#top">Jobs</a>`,
      "https://example.com/",
    );
    expect(urls).toEqual([]);
  });
});

describe("detectJobBoards", () => {
  it("detects boards referenced by script, iframe, or link", () => {
    expect(detectJobBoards(CAREERS_HTML)).toEqual([
      "lever.co",
      "greenhouse.io",
    ]);
  });

  it("returns an empty list when no board is referenced", () => {
    expect(detectJobBoards("<html><body>no jobs here</body></html>")).toEqual(
      [],
    );
  });
});

describe("detectHiringRoles", () => {
  it("finds manual-role hiring phrases", () => {
    expect(
      detectHiringRoles("We are hiring a receptionist and a data entry clerk."),
    ).toEqual(["data entry", "receptionist"]);
  });
});

describe("detectSignals with fingerprint and job evidence", () => {
  it("maps platform artifacts to the existing 7 categories", () => {
    const text = [
      "[tech-fingerprint] meta-generator: WordPress 6.4",
      "[tech-fingerprint] script-src: https://js.intercomcdn.com/widget.js",
      "[tech-fingerprint] script-src: https://assets.calendly.com/assets/external/widget.js",
      "[tech-fingerprint] script-src: https://www.googletagmanager.com/gtag/js?id=GA-1",
      "[tech-fingerprint] header: x-powered-by: ASP.NET",
      "[job-page:/careers] embedded-board: lever.co",
      "[job-page:/careers] hiring-role: receptionist",
    ].join("\n");
    const signals = detectSignals(text);
    const byCode = new Map(signals.map((signal) => [signal.code, signal]));

    expect(byCode.get("fp_wordpress")).toMatchObject({
      category: "digital_foundation",
      polarity: "automated",
    });
    expect(byCode.get("fp_wordpress")?.excerpt).toContain("WordPress 6.4");
    expect(byCode.get("fp_chat_widget")).toMatchObject({
      category: "customer_self_service",
      polarity: "automated",
    });
    expect(byCode.get("fp_chat_widget")?.excerpt).toContain("intercomcdn");
    expect(byCode.get("fp_booking_widget")).toMatchObject({
      category: "workflow_automation",
      polarity: "automated",
    });
    expect(byCode.get("fp_analytics")).toMatchObject({
      category: "data_analytics",
      polarity: "automated",
    });
    expect(byCode.get("fp_legacy_stack")).toMatchObject({
      category: "digital_foundation",
      polarity: "manual",
    });
    expect(byCode.get("fp_legacy_stack")?.excerpt).toContain("ASP.NET");
    expect(byCode.get("job_board_embed")).toMatchObject({
      category: "commercial_urgency",
      polarity: "commercial",
    });
    expect(byCode.get("job_manual_roles")).toMatchObject({
      category: "workflow_automation",
      polarity: "manual",
    });
    // One signal per new code: no duplicates across artifacts.
    expect(new Set(signals.map((signal) => signal.code)).size).toBe(
      signals.length,
    );
  });

  it("fires fp_shopify and fp_site_builder on their artifacts", () => {
    const signals = detectSignals(
      "[tech-fingerprint] script-src: https://cdn.shopify.com/s/trekkie.js\n" +
        "[tech-fingerprint] meta-generator: Wix.com Website Builder",
    );
    const codes = signals.map((signal) => signal.code);
    expect(codes).toContain("fp_shopify");
    expect(codes).toContain("fp_site_builder");
  });

  it("still honors negation guards on prose mentions", () => {
    const signals = detectSignals(
      "We do not use WordPress. Our site is hand-coded.",
    );
    expect(signals.map((signal) => signal.code)).not.toContain("fp_wordpress");
  });

  it("leaves existing rules untouched", () => {
    const signals = detectSignals("Call us to book an appointment today.");
    expect(signals.map((signal) => signal.code)).toEqual(["phone_only"]);
  });

  it("new signals flow through the existing scoring pipeline", () => {
    const signals = detectSignals(
      "[tech-fingerprint] meta-generator: WordPress 6.4\n" +
        "[tech-fingerprint] script-src: https://js.intercomcdn.com/widget.js\n" +
        "[tech-fingerprint] script-src: https://assets.calendly.com/widget.js",
    );
    const score = scoreSignals(signals, {}, {});
    // Automated fingerprint evidence raises maturity above the no-signal
    // baseline of 50 without changing the scoring math itself.
    expect(score.automationMaturity).toBeGreaterThan(50);
    expect(score.coverageCategories).toBe(3);
    expect(score.components.digital_foundation).toBeGreaterThan(50);
  });
});

describe("collectUrl enrichment", () => {
  it("appends fingerprint and job-page evidence within the page budget", async () => {
    const fetcher = createMockFetcher((url) => {
      if (url.pathname === "/careers") return htmlResponse(CAREERS_HTML);
      if (url.pathname === "/jobs") return htmlResponse(JOBS_HTML);
      if (url.pathname === "/join-us") return htmlResponse(JOBS_HTML);
      return htmlResponse(HOMEPAGE_HTML, { "x-powered-by": "PHP/7.4" });
    });

    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
      geocode: false,
    });

    expect(collected.extractedText).toContain(
      "[tech-fingerprint] meta-generator: WordPress 6.4",
    );
    expect(collected.extractedText).toContain(
      "[tech-fingerprint] header: x-powered-by: PHP/7.4",
    );
    expect(collected.extractedText).toContain(
      "[job-page:/careers] embedded-board: lever.co",
    );
    expect(collected.extractedText).toContain(
      "[job-page:/careers] embedded-board: greenhouse.io",
    );
    expect(collected.extractedText).toContain(
      "[job-page:/careers] hiring-role: receptionist",
    );

    const codes = detectSignals(collected.extractedText).map(
      (signal) => signal.code,
    );
    for (const code of [
      "fp_wordpress",
      "fp_chat_widget",
      "fp_booking_widget",
      "fp_analytics",
      "job_board_embed",
      "job_manual_roles",
    ]) {
      expect(codes).toContain(code);
    }

    // Page budget: homepage + at most MAX_JOB_PAGES job pages.
    const jobFetches = fetcher.calls.filter((call) =>
      ["/careers", "/jobs", "/join-us"].some((path) => call.endsWith(path)),
    );
    expect(jobFetches.length).toBeLessThanOrEqual(MAX_JOB_PAGES);
    expect(jobFetches.some((call) => call.endsWith("/join-us"))).toBe(false);
    // External board links are never fetched.
    expect(
      fetcher.calls.some((call) => call.includes("boards.greenhouse.io")),
    ).toBe(false);
  });

  it("skips enrichment for non-HTML content", async () => {
    const fetcher = createMockFetcher(
      () =>
        new Response(JSON.stringify({ hello: "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const collected = await collectUrl(
      "https://example.com/api/info",
      testPolicy,
      fetcher,
      { skipPublicHostCheck: true, geocode: false },
    );
    expect(collected.extractedText).not.toContain("[tech-fingerprint]");
    expect(collected.extractedText).not.toContain("[job-page:");
    expect(collected.coordinates).toBeUndefined();
  });

  it("collects no job pages when none are linked", async () => {
    const fetcher = createMockFetcher((url) => {
      if (url.pathname === "/") return htmlResponse("<html><body>plain</body></html>");
      throw new Error(`unexpected fetch: ${url}`);
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
      geocode: false,
    });
    expect(fetcher.calls).toEqual(["https://example.com/"]);
    expect(collected.extractedText).not.toContain("[job-page:");
  });

  it("survives job-page fetch failures without failing the scrape", async () => {
    const fetcher = createMockFetcher((url) => {
      if (url.pathname === "/careers")
        return new Response("denied", { status: 403 });
      return htmlResponse(HOMEPAGE_HTML);
    });
    const collected = await collectUrl("https://example.com/", testPolicy, fetcher, {
      skipPublicHostCheck: true,
      geocode: false,
    });
    expect(collected.statusCode).toBe(200);
    expect(collected.extractedText).toContain("[tech-fingerprint]");
    expect(collected.extractedText).not.toContain("[job-page:/careers]");
  });
});
