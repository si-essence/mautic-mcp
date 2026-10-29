import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CONNECTOR_NAME } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/listen.js";
import { TOOL_COUNT } from "../src/mautic-catalog.js";
import { createRuntime } from "../src/runtime.js";
import { HTTP_TOKEN, basicEnv, jsonFetch, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

const TOOL_NAMES = [
  "mautic_search_contacts",
  "mautic_get_contact",
  "mautic_create_contact",
  "mautic_update_contact",
  "mautic_add_contact_tags",
  "mautic_remove_contact_tags",
  "mautic_list_segments",
  "mautic_add_contact_to_segment",
  "mautic_remove_contact_from_segment",
  "mautic_list_companies",
  "mautic_get_company",
  "mautic_create_company",
  "mautic_update_company",
  "mautic_add_contact_to_company",
  "mautic_remove_contact_from_company",
  "mautic_list_emails",
  "mautic_get_email",
  "mautic_get_email_stats",
  "mautic_send_email_to_contact",
  "mautic_send_email_to_segment",
  "mautic_list_campaigns",
  "mautic_get_campaign",
  "mautic_add_contact_to_campaign",
  "mautic_remove_contact_from_campaign",
  "mautic_list_forms",
  "mautic_get_form",
  "mautic_list_form_submissions",
  "mautic_list_stages",
  "mautic_change_contact_stage",
  "mautic_adjust_contact_points",
  "mautic_list_point_triggers",
  "mautic_list_point_actions",
  "mautic_list_notes",
  "mautic_create_note",
  "mautic_list_reports",
  "mautic_get_report",
  "mautic_list_stat_tables",
  "mautic_get_stats",
  "mautic_check_contact_dnc",
  "mautic_add_contact_dnc",
  "mautic_remove_contact_dnc",
  "mautic_get_contact_activity",
  "mautic_list_activity",
  "mautic_list_assets",
  "mautic_get_asset",
  "mautic_list_webhook_triggers",
  "mautic_list_webhooks",
  "mautic_get_webhook",
  "mautic_create_webhook",
  "mautic_delete_webhook",
] as const;

describe("mautic-mcp tools", () => {
  it("publishes every Mautic tool with a description", async () => {
    const runtime = runtimeFor(() => Promise.resolve(new Response("unused")));
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
      expect(listed.tools).toHaveLength(TOOL_COUNT);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(0);
      }
    } finally {
      await close();
    }
  });

  it("keeps the package name aligned with package.json", () => {
    const pkg = z
      .object({ name: z.string(), license: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(pkg.name).toBe(CONNECTOR_NAME);
    expect(pkg.license).toBe("MIT");
  });
});

describe("HTTP bind guard", () => {
  const servers: { close: () => void }[] = [];

  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  it("serves /health without a bearer token and requires one on /mcp when set", async () => {
    const { fetchImpl } = jsonFetch(() => Response.json({ ok: true }));
    const runtime = createRuntime(
      loadConfig(
        basicEnv({
          MCP_TRANSPORT: "http",
          PORT: "0",
          MCP_HTTP_AUTH_TOKEN: HTTP_TOKEN,
        }),
        [],
      ),
      { fetchImpl },
    );
    const started = await startHttpServer(runtime);
    servers.push(started.server);
    const origin = `http://127.0.0.1:${started.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");

    const missing = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bind-test", version: "0" },
        },
      }),
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-the-right-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${HTTP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "bind-test", version: "0" },
        },
      }),
    });
    expect(ok.status).not.toBe(401);
    expect(ok.status).toBeGreaterThanOrEqual(200);
    expect(ok.status).toBeLessThan(500);
  });

  it("starts on a non-loopback host when the bearer token is set", async () => {
    const { fetchImpl } = jsonFetch(() => Response.json({ ok: true }));
    const runtime = createRuntime(
      loadConfig(
        basicEnv({
          MCP_TRANSPORT: "http",
          PORT: "0",
          MCP_HTTP_HOST: "0.0.0.0",
          MCP_HTTP_AUTH_TOKEN: HTTP_TOKEN,
        }),
        [],
      ),
      { fetchImpl },
    );
    const started = await startHttpServer(runtime);
    servers.push(started.server);
    const health = await fetch(`http://127.0.0.1:${started.port}/health`);
    expect(health.status).toBe(200);
  });
});
