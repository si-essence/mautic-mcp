import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import {
  ACCESS_TOKEN,
  BASIC_HEADER,
  CLIENT_SECRET,
  PASSWORD,
  basicEnv,
  jsonFetch,
  oauthEnv,
} from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

function assertNoSecret(label: string, text: string, secret: string): void {
  expect(text, label).not.toContain(secret);
  expect(text, label).not.toContain(encodeURIComponent(secret));
}

describe("redact", () => {
  it("strips secrets, url encoding, query params, and Authorization headers", () => {
    const raw = [
      `password=${PASSWORD}`,
      `encoded=${encodeURIComponent(PASSWORD)}`,
      `https://mautic.test/oauth/v2/token?client_secret=${CLIENT_SECRET}&x=1`,
      `Authorization: Basic ${PASSWORD}`,
      `Authorization: Bearer ${ACCESS_TOKEN}`,
    ].join("\n");
    const cleaned = redact(raw, [PASSWORD, CLIENT_SECRET, ACCESS_TOKEN]);
    assertNoSecret("redact password", cleaned, PASSWORD);
    assertNoSecret("redact client secret", cleaned, CLIENT_SECRET);
    assertNoSecret("redact token", cleaned, ACCESS_TOKEN);
    expect(cleaned).toContain("client_secret=[redacted]");
    expect(cleaned).toMatch(/Bearer \[redacted\]/i);
  });

  it("redacts nested strings and object keys", () => {
    const cleaned = JSON.stringify(
      redactUnknown({ [PASSWORD]: [{ title: `see ${PASSWORD}` }] }, [PASSWORD]),
    );
    assertNoSecret("nested", cleaned, PASSWORD);
    expect(cleaned).toContain("[redacted]");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([PASSWORD], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${PASSWORD}`);
    assertNoSecret("logger", lines.join("\n"), PASSWORD);
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the password and basic header out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.method === "GET") {
        return Response.json({ contact: { id: 47, note: `hello ${PASSWORD}` } });
      }
      return new Response(JSON.stringify({ errors: [{ message: `denied ${PASSWORD} ${BASIC_HEADER}` }] }), {
        status: 401,
      });
    });
    const runtime = createRuntime(loadConfig(basicEnv({ MAUTIC_CACHE_TTL_SEC: "0" }), []), {
      fetchImpl,
      logger: createLogger([PASSWORD, BASIC_HEADER], (line) => {
        logs.push(line);
      }),
    });
    const { client, close } = await connectServer(runtime);
    try {
      const ok = readToolText(
        await client.callTool({ name: "mautic_get_contact", arguments: { contact_id: 47 } }),
      );
      const bad = readToolText(
        await client.callTool({
          name: "mautic_create_contact",
          arguments: { email: "ada@example.com", confirm: true },
        }),
      );
      expect(ok.isError).toBe(false);
      expect(ok.text).toContain("[redacted]");
      assertNoSecret("success output", ok.text, PASSWORD);
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("[redacted]");
      assertNoSecret("error output", bad.text, PASSWORD);
      assertNoSecret("error basic header", bad.text, BASIC_HEADER);
      expect(logs.length).toBeGreaterThan(0);
      assertNoSecret("logs", logs.join("\n"), PASSWORD);
      assertNoSecret("stderr", consoleLines.join("\n"), PASSWORD);
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      await close();
    }
  });

  it("keeps the oauth client secret and access token out of errors", async () => {
    const { fetchImpl } = jsonFetch((captured) => {
      if (captured.url.includes("/oauth/v2/token")) {
        return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "bearer" });
      }
      return new Response(
        JSON.stringify({ errors: [{ message: `token ${ACCESS_TOKEN} secret ${CLIENT_SECRET}` }] }),
        { status: 401 },
      );
    });
    const runtime = createRuntime(loadConfig(oauthEnv({ MAUTIC_CACHE_TTL_SEC: "0" }), []), {
      fetchImpl,
    });
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({ name: "mautic_get_contact", arguments: { contact_id: 47 } }),
      );
      expect(result.isError).toBe(true);
      assertNoSecret("oauth error token", result.text, ACCESS_TOKEN);
      assertNoSecret("oauth error secret", result.text, CLIENT_SECRET);
      expect(result.text).toContain("[redacted]");
    } finally {
      await close();
    }
  });
});
