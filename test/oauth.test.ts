import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConnectorError } from "../src/errors.js";
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  jsonFetch,
  oauthRuntimeFor,
  parseForm,
  pathOf,
} from "./harness.js";

const recordSchema = z.record(z.string(), z.unknown());
const TOKEN_PATH = "/oauth/v2/token";

function tokenResponse(token: string, expiresIn = 3600): Response {
  return Response.json({
    access_token: token,
    expires_in: expiresIn,
    token_type: "bearer",
    scope: "",
  });
}

describe("OAuth2 client_credentials", () => {
  it("fetches a token with the form grant and reuses it", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url) === TOKEN_PATH) return tokenResponse(ACCESS_TOKEN);
      return Response.json({ id: 47 });
    });
    const runtime = oauthRuntimeFor(fetchImpl);
    await runtime.client.getJson({ path: "api/contacts/47", query: undefined, ttlSec: 0 }, recordSchema);
    await runtime.client.getJson({ path: "api/contacts/47", query: undefined, ttlSec: 0 }, recordSchema);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.method).toBe("POST");
    expect(pathOf(calls[0]?.url ?? "")).toBe(TOKEN_PATH);
    expect(calls[0]?.contentType).toBe("application/x-www-form-urlencoded");
    expect(parseForm(calls[0]?.rawBody)).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(calls[1]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(calls[2]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(pathOf(calls[1]?.url ?? "")).toBe("/api/contacts/47");
  });

  it("refreshes the token when expires_in has elapsed", async () => {
    let tokens = 0;
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url) === TOKEN_PATH) {
        tokens += 1;
        return tokenResponse(`token-round-${tokens}`, 40);
      }
      return Response.json({ ok: true });
    });
    let now = 1_000;
    const runtime = oauthRuntimeFor(fetchImpl, {}, () => now);
    await runtime.client.getJson({ path: "api/contacts/1", query: undefined, ttlSec: 0 }, recordSchema);
    expect(calls[1]?.authorization).toBe("Bearer token-round-1");
    now += 10_001;
    await runtime.client.getJson({ path: "api/contacts/1", query: undefined, ttlSec: 0 }, recordSchema);
    const tokenCalls = calls.filter((call) => pathOf(call.url) === TOKEN_PATH);
    expect(tokenCalls).toHaveLength(2);
    expect(calls.at(-1)?.authorization).toBe("Bearer token-round-2");
  });

  it("refetches once on HTTP 401 and retries the request", async () => {
    let apiHits = 0;
    let tokens = 0;
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url) === TOKEN_PATH) {
        tokens += 1;
        return tokenResponse(`tok-${tokens}`);
      }
      apiHits += 1;
      if (apiHits === 1) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      return Response.json({ id: 47 });
    });
    const runtime = oauthRuntimeFor(fetchImpl);
    const body = await runtime.client.getJson(
      { path: "api/contacts/47", query: undefined, ttlSec: 0 },
      recordSchema,
    );
    expect(body).toEqual({ id: 47 });
    expect(calls.map((call) => `${call.method} ${pathOf(call.url)}`)).toEqual([
      "POST /oauth/v2/token",
      "GET /api/contacts/47",
      "POST /oauth/v2/token",
      "GET /api/contacts/47",
    ]);
    expect(calls[1]?.authorization).toBe("Bearer tok-1");
    expect(calls[3]?.authorization).toBe("Bearer tok-2");
  });

  it("does not retry a second 401", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url) === TOKEN_PATH) return tokenResponse(ACCESS_TOKEN);
      return new Response(JSON.stringify({ error: { message: "still unauthorized", code: 401 } }), {
        status: 401,
      });
    });
    await expect(
      oauthRuntimeFor(fetchImpl).client.getJson(
        { path: "api/contacts/47", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "auth" });
    const apiCalls = calls.filter((call) => pathOf(call.url) === "/api/contacts/47");
    expect(apiCalls).toHaveLength(2);
  });

  it("shares one in-flight token fetch across concurrent callers", async () => {
    let tokenStarts = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url) === TOKEN_PATH) {
        tokenStarts += 1;
        return gate.then(() => tokenResponse(ACCESS_TOKEN));
      }
      return Response.json({ id: 1 });
    });
    const runtime = oauthRuntimeFor(fetchImpl);
    const pending = [
      runtime.client.getJson({ path: "api/contacts/1", query: undefined, ttlSec: 0 }, recordSchema),
      runtime.client.getJson({ path: "api/contacts/2", query: undefined, ttlSec: 0 }, recordSchema),
      runtime.client.getJson({ path: "api/contacts/3", query: undefined, ttlSec: 0 }, recordSchema),
    ];
    await Promise.resolve();
    expect(tokenStarts).toBe(1);
    release();
    await Promise.all(pending);
    expect(calls.filter((call) => pathOf(call.url) === TOKEN_PATH)).toHaveLength(1);
    expect(calls.filter((call) => pathOf(call.url).startsWith("/api/"))).toHaveLength(3);
  });

  it("maps a token endpoint error without echoing the client secret", async () => {
    const { fetchImpl, calls } = jsonFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_client",
            error_description: `bad secret ${CLIENT_SECRET}`,
          }),
          { status: 401 },
        ),
    );
    try {
      await oauthRuntimeFor(fetchImpl).client.getJson(
        { path: "api/contacts/1", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected auth error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("auth");
      expect(error.message).not.toContain(CLIENT_SECRET);
      expect(error.message).toContain("[redacted]");
    }
    expect(calls).toHaveLength(1);
    expect(pathOf(calls[0]?.url ?? "")).toBe(TOKEN_PATH);
  });
});
