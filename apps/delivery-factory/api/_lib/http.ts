import type { IncomingMessage, ServerResponse } from "node:http";
import type { IntakeHttpRequest } from "./verify.js";

/** Vercel passes query params on req.query for file-system dynamic routes. */
export type ApiRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

export const INTAKE_BODY_PARSER_CONFIG = { api: { bodyParser: false } };

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function firstHeader(
  headers: IncomingMessage["headers"],
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function toIntakeRequest(
  req: ApiRequest,
  rawBody: string,
): IntakeHttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  const originHeader = firstHeader(req.headers, "origin");
  return {
    method: (req.method ?? "GET").toUpperCase(),
    origin: originHeader ?? null,
    headers,
    rawBody,
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(body === null || body === undefined ? "" : JSON.stringify(body));
}

export function routeParam(
  req: ApiRequest,
  name: string,
): string | undefined {
  const value = req.query?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function errorStatus(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  ) {
    return (error as { statusCode: number }).statusCode;
  }
  return 500;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

/** Reads a JSON body for non-intake routes (body parsing is fine there). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}
