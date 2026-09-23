import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPinnedFetcher,
  resolvePublicHost,
  type PinnedAddress,
} from "../api/_lib/collection";

const publicResolver = async (hostname: string): Promise<PinnedAddress[]> => [
  { address: "127.0.0.1", family: 4 },
];

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startLocalServer(
  handler: (host: string | undefined) => void,
): Promise<number> {
  const server = createServer((req, res) => {
    handler(req.headers.host);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

describe("resolvePublicHost", () => {
  it("rejects loopback hostnames without needing the network", async () => {
    // "localhost" resolves via the hosts file, so this is hermetic.
    await expect(resolvePublicHost("localhost")).rejects.toThrow(
      /private|loopback|prohibited/i,
    );
  });

  it("rejects cloud metadata hostnames", async () => {
    await expect(
      resolvePublicHost("metadata.google.internal"),
    ).rejects.toThrow(/prohibited/i);
  });
});

describe("createPinnedFetcher", () => {
  it("connects to the pinned address even when the hostname cannot resolve", async () => {
    let seenHost: string | undefined;
    const port = await startLocalServer((host) => {
      seenHost = host;
    });
    // example.invalid never resolves via real DNS: success proves the
    // connection went to the pinned 127.0.0.1, not through the resolver.
    const fetchPinned = createPinnedFetcher(publicResolver);
    const response = await fetchPinned(
      `http://example.invalid:${port}/some/path`,
    );
    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("pinned-ok");
    // Virtual hosting is preserved: the origin host survives pinning.
    expect(seenHost).toBe(`example.invalid:${port}`);
  });

  it("propagates resolver rejections (private destinations stay blocked)", async () => {
    const fetchPinned = createPinnedFetcher(async (hostname) => {
      await resolvePublicHost(hostname);
      return [{ address: "127.0.0.1", family: 4 }];
    });
    await expect(
      fetchPinned("http://localhost:9/"),
    ).rejects.toThrow(/private|loopback|prohibited/i);
  });

  it("exposes status, ok, headers, and text like fetch", async () => {
    const port = await startLocalServer(() => {});
    const fetchPinned = createPinnedFetcher(publicResolver);
    const response = await fetchPinned(`http://example.invalid:${port}/`);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.body).toBeTruthy();
  });
});
