import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApiRequest } from "./router.js";

export const functionConfig = {
};

type VercelRequest = IncomingMessage & { body?: unknown };

async function requestBody(
  request: VercelRequest,
): Promise<BodyInit | undefined> {
  if (["GET", "HEAD"].includes(request.method ?? "GET")) return undefined;
  if (request.body !== undefined) {
    return typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

/**
 * Shared Vercel function handler. Each explicit endpoint file under api/
 * re-exports this; the central router in server/router.ts performs its own
 * pathname routing, auth, and validation.
 */
export default async function apiHandler(
  request: VercelRequest,
  response: ServerResponse,
): Promise<void> {
  const forwardedProtocol = String(
    request.headers["x-forwarded-proto"] ?? "https",
  ).split(",")[0];
  const host = request.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value))
      value.forEach((item) => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  const webRequest = new Request(
    `${forwardedProtocol}://${host}${request.url ?? "/"}`,
    {
      method: request.method,
      headers,
      body: await requestBody(request),
    },
  );
  const result = await handleApiRequest(webRequest);
  response.statusCode = result.status;
  result.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await result.arrayBuffer()));
}
