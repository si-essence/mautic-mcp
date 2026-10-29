import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { createRuntime } from "../src/runtime.js";
import { BASIC_HEADER, PASSWORD, basicEnv, jsonFetch, pathOf, runtimeFor } from "./harness.js";

const recordSchema = z.record(z.string(), z.unknown());

describe("HttpClient", () => {
  it("sends Basic auth, caches the parsed body, and skips the cache after ttl", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ id: 47, email: "a@b.com" }));
    let now = 0;
    const runtime = runtimeFor(fetchImpl, { MAUTIC_CACHE_TTL_SEC: "30" }, () => now);
    const first = await runtime.client.getJson(
      { path: "api/contacts/47", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    const second = await runtime.client.getJson(
      { path: "api/contacts/47", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    expect(first).toEqual({ id: 47, email: "a@b.com" });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(pathOf(calls[0]?.url ?? "")).toBe("/api/contacts/47");
    expect(calls[0]?.authorization).toBe(BASIC_HEADER);
    now = 31_000;
    await runtime.client.getJson(
      { path: "api/contacts/47", query: undefined, ttlSec: 30 },
      recordSchema,
    );
    expect(calls).toHaveLength(2);
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ id: 1 }));
    const runtime = runtimeFor(
      fetchImpl,
      { MAUTIC_PER_MINUTE: "1", MAUTIC_CACHE_TTL_SEC: "60" },
      () => 0,
    );
    await runtime.client.getJson({ path: "api/contacts/1", query: undefined, ttlSec: 60 }, recordSchema);
    await runtime.client.getJson({ path: "api/contacts/1", query: undefined, ttlSec: 60 }, recordSchema);
    await expect(
      runtime.client.getJson({ path: "api/contacts/2", query: undefined, ttlSec: 60 }, recordSchema),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(calls).toHaveLength(1);
  });

  it("posts and patches JSON, skips the cache, and clears cached GETs after a write", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.method === "POST" || captured.method === "PATCH") {
        return Response.json({ success: true });
      }
      return Response.json({ id: 1 });
    });
    const runtime = runtimeFor(fetchImpl, { MAUTIC_CACHE_TTL_SEC: "60" }, () => 0);
    await runtime.client.getJson({ path: "api/contacts", query: undefined, ttlSec: 60 }, recordSchema);
    await runtime.client.getJson({ path: "api/contacts", query: undefined, ttlSec: 60 }, recordSchema);
    expect(calls).toHaveLength(1);
    const posted = await runtime.client.postJson(
      {
        path: "api/contacts/new",
        query: undefined,
        body: { email: "ada@example.com" },
        ttlSec: 0,
        invalidate: true,
      },
      recordSchema,
    );
    expect(posted).toEqual({ success: true });
    expect(calls[1]?.method).toBe("POST");
    expect(pathOf(calls[1]?.url ?? "")).toBe("/api/contacts/new");
    expect(calls[1]?.authorization).toBe(BASIC_HEADER);
    expect(calls[1]?.contentType).toBe("application/json");
    expect(calls[1]?.body).toEqual({ email: "ada@example.com" });
    await runtime.client.getJson({ path: "api/contacts", query: undefined, ttlSec: 60 }, recordSchema);
    expect(calls).toHaveLength(3);
    const patched = await runtime.client.patchJson(
      {
        path: "api/contacts/47/edit",
        query: undefined,
        body: { tags: ["vip"] },
        ttlSec: 0,
        invalidate: true,
      },
      recordSchema,
    );
    expect(patched).toEqual({ success: true });
    expect(calls[3]?.method).toBe("PATCH");
    expect(pathOf(calls[3]?.url ?? "")).toBe("/api/contacts/47/edit");
    expect(calls[3]?.body).toEqual({ tags: ["vip"] });
  });

  it("posts with no JSON body when body is omitted", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: true }));
    const runtime = runtimeFor(fetchImpl);
    await runtime.client.postJson(
      {
        path: "api/segments/1/contact/47/add",
        query: undefined,
        body: undefined,
        ttlSec: 0,
        invalidate: true,
      },
      recordSchema,
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.contentType).toBeNull();
  });

  it("maps Mautic error shapes and HTTP status codes", async () => {
    const cases: { status: number; body: unknown; code: string; retry?: number }[] = [
      {
        status: 400,
        body: { errors: [{ message: "email is invalid", code: 400, type: "invalid" }] },
        code: "input",
      },
      {
        status: 401,
        body: { error: { message: "access denied", code: 401 } },
        code: "auth",
      },
      {
        status: 403,
        body: { error: { message: "You do not have access to the requested area/action.", code: 403 } },
        code: "upstream",
      },
      {
        status: 404,
        body: { errors: [{ message: "Item was not found.", code: 404, details: [] }] },
        code: "not_found",
      },
      {
        status: 429,
        body: { errors: [{ message: "Too many requests", code: 429 }] },
        code: "rate_limit",
        retry: 4,
      },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(() => {
        const init: ResponseInit = { status: testCase.status };
        if (testCase.retry !== undefined) init.headers = { "retry-after": String(testCase.retry) };
        return new Response(JSON.stringify(testCase.body), init);
      });
      try {
        await runtimeFor(fetchImpl).client.getJson(
          { path: "api/contacts/1", query: undefined, ttlSec: 0 },
          recordSchema,
        );
        throw new Error(`expected ${testCase.code}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConnectorError);
        if (!(error instanceof ConnectorError)) throw error;
        expect(error.code).toBe(testCase.code);
        if (testCase.retry !== undefined) expect(error.retryAfterSeconds).toBe(testCase.retry);
        if (testCase.status === 400) expect(error.message).toContain("email is invalid");
        if (testCase.status === 401) expect(error.message).toContain("access denied");
        if (testCase.status === 404) expect(error.message).toContain("Item was not found.");
      }
    }
  });

  it("keeps field details that the message does not already include", async () => {
    const cases = [
      {
        status: 400,
        body: {
          errors: [
            {
              code: 400,
              message: "email: not-an-email is invalid.",
              details: { email: ["not-an-email is invalid."] },
            },
          ],
        },
        code: "input",
        includes: "email: not-an-email is invalid.",
        excludes: "(email:",
      },
      {
        status: 400,
        body: {
          errors: [
            {
              message: "Validation failed",
              code: 400,
              type: null,
              details: { email: ["bad"] },
            },
          ],
        },
        code: "input",
        includes: "Validation failed (email: bad)",
        excludes: "",
      },
      {
        status: 500,
        body: { errors: [{ message: "An unexpected error occurred.", code: 500, type: null }] },
        code: "upstream",
        includes: "An unexpected error occurred.",
        excludes: "",
      },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(
        () => new Response(JSON.stringify(testCase.body), { status: testCase.status }),
      );
      await expect(
        runtimeFor(fetchImpl).client.getJson(
          { path: "api/contacts/1", query: undefined, ttlSec: 0 },
          recordSchema,
        ),
      ).rejects.toMatchObject({ code: testCase.code });
      try {
        await runtimeFor(fetchImpl).client.getJson(
          { path: "api/contacts/1", query: undefined, ttlSec: 0 },
          recordSchema,
        );
      } catch (error) {
        if (!(error instanceof ConnectorError)) throw error;
        expect(error.message).toContain(testCase.includes);
        if (testCase.excludes.length > 0) expect(error.message).not.toContain(testCase.excludes);
      }
    }
  });

  it("sends DELETE with no body", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ hook: { id: null, name: "Gone" } }));
    const runtime = runtimeFor(fetchImpl);
    const body = await runtime.client.deleteJson(
      { path: "api/hooks/4/delete", query: undefined, ttlSec: 0, invalidate: true },
      recordSchema,
    );
    expect(body).toEqual({ hook: { id: null, name: "Gone" } });
    expect(calls[0]?.method).toBe("DELETE");
    expect(pathOf(calls[0]?.url ?? "")).toBe("/api/hooks/4/delete");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.contentType).toBeNull();
    expect(calls[0]?.authorization).toBe(BASIC_HEADER);
  });

  it("maps OAuth error_description on a token-shaped body", async () => {
    const { fetchImpl } = jsonFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "token expired" }), {
          status: 400,
        }),
    );
    try {
      await runtimeFor(fetchImpl).client.getJson(
        { path: "api/contacts/1", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected input error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("input");
      expect(error.message).toContain("token expired");
    }
  });

  it("redacts a secret that the upstream body or a network error tried to echo", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error(`connect failed ${PASSWORD} ${encodeURIComponent(PASSWORD)}`);
    });
    const runtime = createRuntime(loadConfig(basicEnv(), []), {
      fetchImpl,
      logger: { info: () => undefined, error: (message) => logs.push(message) },
    });
    try {
      await runtime.client.getJson(
        { path: "api/contacts/1", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).not.toContain(encodeURIComponent(PASSWORD));
      expect(error.message).toContain("[redacted]");
    }
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(PASSWORD);

    const echoed = jsonFetch(
      () => new Response(JSON.stringify({ errors: [{ message: `denied ${PASSWORD}` }] }), { status: 401 }),
    );
    try {
      await runtimeFor(echoed.fetchImpl).client.getJson(
        { path: "api/contacts/1", query: undefined, ttlSec: 0 },
        recordSchema,
      );
      throw new Error("expected auth error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).toContain("[redacted]");
    }
  });

  it("refuses to put a secret in the query string", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ id: 1 }));
    const runtime = runtimeFor(fetchImpl);
    await expect(
      runtime.client.getJson({ path: "api/contacts", query: { search: PASSWORD }, ttlSec: 0 }, recordSchema),
    ).rejects.toThrow(/request URL/);
    expect(calls).toHaveLength(0);
  });

  it("maps timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const timeoutRuntime = runtimeFor(hanging, { MAUTIC_TIMEOUT_MS: "100" });
    await expect(
      timeoutRuntime.client.getJson(
        { path: "api/contacts/1", query: undefined, ttlSec: 0 },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("treats an empty 2xx body as an empty object", async () => {
    const { fetchImpl } = jsonFetch(() => new Response("", { status: 200 }));
    const parsed = await runtimeFor(fetchImpl).client.postJson(
      {
        path: "api/segments/1/contact/47/add",
        query: undefined,
        body: undefined,
        ttlSec: 0,
        invalidate: true,
      },
      recordSchema,
    );
    expect(parsed).toEqual({});
  });
});
