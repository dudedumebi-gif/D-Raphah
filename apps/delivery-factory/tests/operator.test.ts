import { beforeEach, describe, expect, it } from "vitest";
import {
  operatorAllowlist,
  requireOperator,
  type OperatorSession,
  type SessionValidator,
} from "../api/_lib/operator.js";
import type { ApiRequest } from "../api/_lib/http.js";

/**
 * Operator auth tests. The session validator is stubbed (no network, no
 * database): it returns a canned session for known tokens and null for
 * unknown ones, mirroring the production better-auth table lookup.
 */

const SESSIONS: Record<string, OperatorSession> = {
  "valid-token": { email: "ops@example.com" },
  "upper-token": { email: "OPS@EXAMPLE.COM" },
  "intruder-token": { email: "intruder@example.com" },
  "noemail-token": { email: "   " },
};

const validator: SessionValidator = async (token: string) =>
  SESSIONS[token] ?? null;

function reqWith(token: string | null): ApiRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as ApiRequest;
}

beforeEach(() => {
  process.env.OPERATOR_EMAILS = "ops@example.com, Admin@Example.com";
});

describe("requireOperator", () => {
  it("passes a valid session whose email is allowlisted", async () => {
    const identity = await requireOperator(reqWith("valid-token"), validator);
    expect(identity.email).toBe("ops@example.com");
  });

  it("compares emails case-insensitively", async () => {
    const identity = await requireOperator(reqWith("upper-token"), validator);
    expect(identity.email).toBe("ops@example.com");
  });

  it("rejects a valid session whose email is not allowlisted (403)", async () => {
    const err = await requireOperator(reqWith("intruder-token"), validator).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("rejects an unknown token (401)", async () => {
    const err = await requireOperator(reqWith("nope-not-a-session"), validator).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a missing Authorization header (401)", async () => {
    const err = await requireOperator(reqWith(null), validator).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a malformed bearer value (401)", async () => {
    const err = await requireOperator(
      { headers: { authorization: "Token abc.def" } } as ApiRequest,
      validator,
    ).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 401 });
  });

  it("rejects a valid session with no email (403)", async () => {
    const err = await requireOperator(reqWith("noemail-token"), validator).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ statusCode: 403 });
  });

  it("lets validator failures propagate (mapped to 500, not 401)", async () => {
    const boom: SessionValidator = async () => {
      throw new Error("database unreachable");
    };
    const err = await requireOperator(reqWith("valid-token"), boom).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toMatchObject({ statusCode: 401 });
    expect(err).not.toMatchObject({ statusCode: 403 });
  });
});

describe("operatorAllowlist", () => {
  it("parses comma-separated emails, trimmed and lowercased", () => {
    process.env.OPERATOR_EMAILS = "  Ops@Example.com ,,admin@example.com ";
    expect(operatorAllowlist()).toEqual([
      "ops@example.com",
      "admin@example.com",
    ]);
  });

  it("is empty when the env var is unset", () => {
    delete process.env.OPERATOR_EMAILS;
    expect(operatorAllowlist()).toEqual([]);
  });
});
