import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolDescription, toolName, type ToolDescription } from "../src/brand.js";
import { ConnectorError } from "../src/errors.js";
import { createLogger } from "../src/log.js";
import {
  adjustContactPointsInput,
  createContactInput,
  createNoteInput,
  sendEmailToContactInput,
} from "../src/mautic-catalog.js";
import { assertToolSpec, READ_ONLY_REMOTE, registerConnectorTool } from "../src/tools.js";
import { confirmField } from "../src/write.js";
import {
  ACCESS_TOKEN,
  BASIC_HEADER,
  jsonFetch,
  oauthRuntimeFor,
  pathOf,
  queryOf,
  runtimeFor,
} from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const ctx = { secrets: [] as const, logger: createLogger([]) };

function parseObject(text: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

async function withTool<T>(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  fn: (client: Awaited<ReturnType<typeof connectServer>>["client"]) => Promise<T>,
): Promise<T> {
  const runtime = runtimeFor(fetchImpl, extra);
  const { client, close } = await connectServer(runtime);
  try {
    return await fn(client);
  } finally {
    await close();
  }
}

describe("tool registration", () => {
  it("rejects a blank description at the boundary", () => {
    expect(() => toolDescription("   ")).toThrow(ConnectorError);
    expect(() => toolName("Bad-Name")).toThrow(ConnectorError);
  });

  it("rejects an empty description and a non-object schema at runtime", () => {
    expect(() => {
      assertToolSpec({ name: "mautic_get_contact", description: "  ", inputSchema: z.object({}) });
    }).toThrow(/non-empty description/);
    expect(() => {
      assertToolSpec({
        name: "mautic_get_contact",
        description: "Get one contact.",
        inputSchema: z.string(),
      });
    }).toThrow(/Zod object schema/);
  });

  it("rejects a branded empty description before the tool is published", () => {
    const server = new McpServer({ name: "t", version: "0" });
    expect(() => {
      registerConnectorTool(
        server,
        {
          name: toolName("mautic_get_contact"),
          description: "   " as ToolDescription,
          inputSchema: z.object({}),
          annotations: READ_ONLY_REMOTE,
          handler: () => Promise.resolve({}),
        },
        ctx,
      );
    }).toThrow(/non-empty description/);
  });
});

const keyedContacts = {
  total: "2",
  contacts: { "47": { id: 47, email: "a@x.com" }, "48": { id: 48, email: "b@x.com" } },
};

interface ReadCase {
  name: string;
  args: Record<string, unknown>;
  path: string;
  query?: Record<string, string>;
  response: unknown;
  expected: Record<string, unknown>;
  forbidden?: string;
}

const READ_CASES: ReadCase[] = [
  {
    name: "mautic_search_contacts",
    args: { search: "email:*@example.com" },
    path: "/api/contacts",
    query: { search: "email:*@example.com", start: "0", limit: "30" },
    response: keyedContacts,
    expected: {
      total: 2,
      start: 0,
      limit: 30,
      items: [
        { id: 47, email: "a@x.com" },
        { id: 48, email: "b@x.com" },
      ],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_contact",
    args: { contact_id: 47 },
    path: "/api/contacts/47",
    response: { contact: { id: 47, email: "ada@example.com" } },
    expected: { contact: { id: 47, email: "ada@example.com" } },
  },
  {
    name: "mautic_list_segments",
    args: {},
    path: "/api/segments",
    query: { start: "0", limit: "30" },
    response: { total: 1, lists: { "2": { id: 2, alias: "vip" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 2, alias: "vip" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_companies",
    args: { start: 0, limit: 10 },
    path: "/api/companies",
    query: { start: "0", limit: "10" },
    response: { total: 1, companies: { "9": { id: 9, companyname: "Acme" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 10,
      items: [{ id: 9, companyname: "Acme" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_company",
    args: { company_id: 9 },
    path: "/api/companies/9",
    response: { company: { id: 9, companyname: "Acme" } },
    expected: { company: { id: 9, companyname: "Acme" } },
  },
  {
    name: "mautic_list_emails",
    args: {},
    path: "/api/emails",
    query: { start: "0", limit: "30" },
    response: { total: 1, emails: { "5": { id: 5, name: "Welcome" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 5, name: "Welcome" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_email",
    args: { email_id: 5 },
    path: "/api/emails/5",
    response: { email: { id: 5, name: "Welcome", sentCount: 3, readCount: 1 } },
    expected: { email: { id: 5, name: "Welcome", sentCount: 3, readCount: 1 } },
  },
  {
    name: "mautic_get_email_stats",
    args: { email_id: 5 },
    path: "/api/emails/5",
    response: {
      email: { id: 5, sentCount: 3, readCount: 1, variantSentCount: 0, variantReadCount: 0 },
    },
    expected: {
      sentCount: 3,
      readCount: 1,
      variantSentCount: 0,
      variantReadCount: 0,
      email: { id: 5, sentCount: 3, readCount: 1, variantSentCount: 0, variantReadCount: 0 },
    },
  },
  {
    name: "mautic_list_campaigns",
    args: {},
    path: "/api/campaigns",
    query: { start: "0", limit: "30" },
    response: { total: 1, campaigns: { "3": { id: 3, name: "Nurture" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 3, name: "Nurture" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_campaign",
    args: { campaign_id: 3 },
    path: "/api/campaigns/3",
    response: { campaign: { id: 3, name: "Nurture" } },
    expected: { campaign: { id: 3, name: "Nurture" } },
  },
  {
    name: "mautic_list_forms",
    args: {},
    path: "/api/forms",
    query: { start: "0", limit: "30" },
    response: { total: 1, forms: { "8": { id: 8, name: "Signup" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 8, name: "Signup" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_form",
    args: { form_id: 8 },
    path: "/api/forms/8",
    response: { form: { id: 8, name: "Signup" } },
    expected: { form: { id: 8, name: "Signup" } },
  },
  {
    name: "mautic_list_form_submissions",
    args: { form_id: 8 },
    path: "/api/forms/8/submissions",
    query: { start: "0", limit: "30" },
    response: { total: "1", submissions: { "11": { id: 11 } } },
    expected: { total: 1, start: 0, limit: 30, items: [{ id: 11 }], nextStart: null },
  },
  {
    name: "mautic_list_stages",
    args: {},
    path: "/api/stages",
    query: { start: "0", limit: "30" },
    response: { total: 1, stages: { "4": { id: 4, name: "Customer" } } },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 4, name: "Customer" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_point_triggers",
    args: {},
    path: "/api/points/triggers",
    query: { start: "0", limit: "30" },
    response: { total: 1, triggers: [{ id: 1, name: "Trigger test" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 1, name: "Trigger test" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_point_actions",
    args: {},
    path: "/api/points",
    query: { start: "0", limit: "30" },
    response: { total: 1, points: [{ id: 1, name: "Opens Email" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 1, name: "Opens Email" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_notes",
    args: {},
    path: "/api/notes",
    query: { start: "0", limit: "30" },
    response: { total: 1, notes: [{ id: 1, text: "Hello", lead: { id: 47 } }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 1, text: "Hello", lead: { id: 47 } }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_notes",
    args: { contact_id: 47 },
    path: "/api/contacts/47/notes",
    query: { start: "0", limit: "30" },
    response: { total: 1, notes: [{ id: 1, text: "Hello" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 1, text: "Hello" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_list_reports",
    args: {},
    path: "/api/reports",
    query: { start: "0", limit: "30" },
    response: { total: 1, reports: [{ id: 3, name: "Contacts" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 3, name: "Contacts" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_report",
    args: { report_id: 3, dateFrom: "2017-01-01", dateTo: "2018-01-01", limit: 5, page: 3 },
    path: "/api/reports/3",
    query: { dateFrom: "2017-01-01", dateTo: "2018-01-01", limit: "5", page: "3" },
    response: { totalResults: 3990, data: [{ id2: "12" }] },
    expected: { totalResults: 3990, data: [{ id2: "12" }] },
  },
  {
    name: "mautic_list_stat_tables",
    args: {},
    path: "/api/stats",
    response: { availableTables: ["email_stats", "form_submissions"] },
    expected: { availableTables: ["email_stats", "form_submissions"] },
  },
  {
    name: "mautic_get_stats",
    args: {
      table: "email_stats",
      start: 0,
      limit: 30,
      order: [{ col: "id", dir: "asc" }],
      where: [{ col: "email_id", expr: "eq", val: 5 }],
    },
    path: "/api/stats/email_stats",
    query: {
      start: "0",
      limit: "30",
      "order[0][col]": "id",
      "order[0][dir]": "asc",
      "where[0][col]": "email_id",
      "where[0][expr]": "eq",
      "where[0][val]": "5",
    },
    response: { total: 1, stats: [{ id: "1", email_id: "5" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: "1", email_id: "5" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_check_contact_dnc",
    args: { contact_id: 47 },
    path: "/api/contacts/47",
    response: {
      contact: {
        id: 47,
        doNotContact: [{ id: 2, reason: 1, comments: "", channel: "email", channelId: null }],
      },
    },
    expected: {
      contactId: "47",
      channel: null,
      entries: [{ id: 2, reason: 1, comments: "", channel: "email", channelId: null }],
    },
  },
  {
    name: "mautic_get_contact_activity",
    args: {
      contact_id: 47,
      search: "segment",
      includeEvents: ["segment_membership"],
      excludeEvents: ["page.hit"],
      dateFrom: "2020-01-01 00:00:00",
      dateTo: "2026-10-17 00:00:00",
      order: ["timestamp", "desc"],
      page: 1,
      limit: 25,
    },
    path: "/api/contacts/47/activity",
    query: {
      "filters[search]": "segment",
      "filters[includeEvents][]": "segment_membership",
      "filters[excludeEvents][]": "page.hit",
      "filters[dateFrom]": "2020-01-01 00:00:00",
      "filters[dateTo]": "2026-10-17 00:00:00",
      "order[0]": "timestamp",
      "order[1]": "DESC",
      page: "1",
      limit: "25",
    },
    response: {
      events: [
        {
          event: "segment_membership",
          eventType: "Segment membership change",
          timestamp: "2026-10-17T13:30:29+00:00",
          contactId: "4",
        },
      ],
      filters: { search: "segment", includeEvents: ["segment_membership"], excludeEvents: ["page.hit"] },
      order: ["timestamp", "DESC"],
      types: { segment_membership: "Segment membership change" },
      total: "1",
      page: 1,
      limit: 25,
      maxPages: 1,
    },
    expected: {
      total: 1,
      page: 1,
      limit: 25,
      maxPages: 1,
      events: [
        {
          event: "segment_membership",
          eventType: "Segment membership change",
          timestamp: "2026-10-17T13:30:29+00:00",
          contactId: "4",
        },
      ],
      filters: { search: "segment", includeEvents: ["segment_membership"], excludeEvents: ["page.hit"] },
      order: ["timestamp", "DESC"],
      types: { segment_membership: "Segment membership change" },
    },
  },
  {
    name: "mautic_list_activity",
    args: {},
    path: "/api/contacts/activity",
    response: {
      events: [{ event: "lead.identified", contactId: "7" }],
      filters: { search: "", includeEvents: [], excludeEvents: [] },
      order: ["timestamp", "ASC"],
      types: { "lead.identified": "Contact identified" },
      total: 1,
      page: 1,
      limit: 25,
      maxPages: 1,
    },
    expected: {
      total: 1,
      page: 1,
      limit: 25,
      maxPages: 1,
      events: [{ event: "lead.identified", contactId: "7" }],
      filters: { search: "", includeEvents: [], excludeEvents: [] },
      order: ["timestamp", "ASC"],
      types: { "lead.identified": "Contact identified" },
    },
  },
  {
    name: "mautic_list_assets",
    args: { search: "robots" },
    path: "/api/assets",
    query: { search: "robots", start: "0", limit: "30" },
    response: { total: 1, assets: [{ id: 1, title: "Robots file" }] },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [{ id: 1, title: "Robots file" }],
      nextStart: null,
    },
  },
  {
    name: "mautic_get_asset",
    args: { asset_id: 1 },
    path: "/api/assets/1",
    response: { asset: { id: 1, title: "Robots file", downloadUrl: "http://127.0.0.1:8080/asset/1" } },
    expected: { asset: { id: 1, title: "Robots file", downloadUrl: "http://127.0.0.1:8080/asset/1" } },
  },
  {
    name: "mautic_list_webhook_triggers",
    args: {},
    path: "/api/hooks/triggers",
    response: {
      triggers: {
        "mautic.lead_post_save_new": {
          label: "Contact Identified Event",
          description: "Triggered when a contact is identified.",
        },
        "mautic.company_post_save": {
          label: "Company Create/Update Event",
          description: "Triggered when a company is created/updated",
        },
      },
    },
    expected: {
      triggers: [
        {
          name: "mautic.company_post_save",
          label: "Company Create/Update Event",
          description: "Triggered when a company is created/updated",
        },
        {
          name: "mautic.lead_post_save_new",
          label: "Contact Identified Event",
          description: "Triggered when a contact is identified.",
        },
      ],
    },
  },
  {
    name: "mautic_list_webhooks",
    args: {},
    path: "/api/hooks",
    query: { start: "0", limit: "30" },
    response: {
      total: "1",
      hooks: {
        "2": {
          id: 2,
          name: "Points",
          webhookUrl: "https://example.com/hook",
          secret: "hook-signing-secret-99",
          triggers: ["mautic.lead_points_change"],
        },
      },
    },
    expected: {
      total: 1,
      start: 0,
      limit: 30,
      items: [
        {
          id: 2,
          name: "Points",
          webhookUrl: "https://example.com/hook",
          triggers: ["mautic.lead_points_change"],
        },
      ],
      nextStart: null,
    },
    forbidden: "hook-signing-secret-99",
  },
  {
    name: "mautic_get_webhook",
    args: { webhook_id: 2 },
    path: "/api/hooks/2",
    response: {
      hook: {
        id: 2,
        name: "Points",
        webhookUrl: "https://example.com/hook",
        secret: "hook-signing-secret-99",
        triggers: ["mautic.lead_points_change"],
      },
    },
    expected: {
      hook: {
        id: 2,
        name: "Points",
        webhookUrl: "https://example.com/hook",
        triggers: ["mautic.lead_points_change"],
      },
    },
    forbidden: "hook-signing-secret-99",
  },
];

describe("read tools", () => {
  for (const testCase of READ_CASES) {
    const label = `${testCase.name} GET ${testCase.path}`;
    it(label, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json(testCase.response));
      await withTool(fetchImpl, {}, async (client) => {
        const result = readToolText(
          await client.callTool({ name: testCase.name, arguments: testCase.args }),
        );
        expect(result.isError).toBe(false);
        expect(parseObject(result.text)).toEqual(testCase.expected);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("GET");
        expect(pathOf(calls[0]?.url ?? "")).toBe(testCase.path);
        expect(calls[0]?.authorization).toBe(BASIC_HEADER);
        if (testCase.query === undefined) {
          expect(queryOf(calls[0]?.url ?? "")).toEqual({});
        } else {
          expect(queryOf(calls[0]?.url ?? "")).toEqual(testCase.query);
        }
        if (testCase.forbidden !== undefined) {
          expect(result.text).not.toContain(testCase.forbidden);
        }
      });
    });
  }
});

describe("pagination", () => {
  it("caps limit at MAUTIC_MAX_LIMIT and sets nextStart", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({ total: "5", contacts: { "47": { id: 47 } } }),
    );
    await withTool(fetchImpl, { MAUTIC_MAX_LIMIT: "50" }, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_search_contacts",
          arguments: { start: 0, limit: 200 },
        }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({
        total: 5,
        start: 0,
        limit: 50,
        items: [{ id: 47 }],
        nextStart: 1,
      });
      expect(queryOf(calls[0]?.url ?? "")).toEqual({ start: "0", limit: "50" });
    });
  });

  it("rejects a limit above 500 with zero calls", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ total: 0, contacts: {} }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_search_contacts",
          arguments: { limit: 501 },
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.text.toLowerCase()).toMatch(/input/);
      expect(calls).toHaveLength(0);
    });
  });
});

interface WriteCase {
  name: string;
  args: Record<string, unknown>;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  planPath: string;
  body: unknown;
}

const WRITE_CASES: WriteCase[] = [
  {
    name: "mautic_create_contact",
    args: { email: "ada@example.com", firstname: "Ada" },
    method: "POST",
    path: "/api/contacts/new",
    planPath: "api/contacts/new",
    body: { email: "ada@example.com", firstname: "Ada" },
  },
  {
    name: "mautic_update_contact",
    args: { contact_id: 47, lastname: "Lovelace" },
    method: "PATCH",
    path: "/api/contacts/47/edit",
    planPath: "api/contacts/47/edit",
    body: { lastname: "Lovelace" },
  },
  {
    name: "mautic_add_contact_tags",
    args: { contact_id: 47, tags: ["vip", "gold"] },
    method: "PATCH",
    path: "/api/contacts/47/edit",
    planPath: "api/contacts/47/edit",
    body: { tags: ["vip", "gold"] },
  },
  {
    name: "mautic_remove_contact_tags",
    args: { contact_id: 47, tags: ["vip"] },
    method: "PATCH",
    path: "/api/contacts/47/edit",
    planPath: "api/contacts/47/edit",
    body: { tags: ["-vip"] },
  },
  {
    name: "mautic_add_contact_to_segment",
    args: { segment_id: 2, contact_id: 47 },
    method: "POST",
    path: "/api/segments/2/contact/47/add",
    planPath: "api/segments/2/contact/47/add",
    body: undefined,
  },
  {
    name: "mautic_remove_contact_from_segment",
    args: { segment_id: 2, contact_id: 47 },
    method: "POST",
    path: "/api/segments/2/contact/47/remove",
    planPath: "api/segments/2/contact/47/remove",
    body: undefined,
  },
  {
    name: "mautic_create_company",
    args: { companyname: "Acme" },
    method: "POST",
    path: "/api/companies/new",
    planPath: "api/companies/new",
    body: { companyname: "Acme" },
  },
  {
    name: "mautic_update_company",
    args: { company_id: 9, companycity: "Austin" },
    method: "PATCH",
    path: "/api/companies/9/edit",
    planPath: "api/companies/9/edit",
    body: { companycity: "Austin" },
  },
  {
    name: "mautic_add_contact_to_company",
    args: { company_id: 9, contact_id: 47 },
    method: "POST",
    path: "/api/companies/9/contact/47/add",
    planPath: "api/companies/9/contact/47/add",
    body: undefined,
  },
  {
    name: "mautic_remove_contact_from_company",
    args: { company_id: 9, contact_id: 47 },
    method: "POST",
    path: "/api/companies/9/contact/47/remove",
    planPath: "api/companies/9/contact/47/remove",
    body: undefined,
  },
  {
    name: "mautic_send_email_to_contact",
    args: { email_id: 5, contact_id: 47, tokens: { "{first_name}": "Ada" } },
    method: "POST",
    path: "/api/emails/5/contact/47/send",
    planPath: "api/emails/5/contact/47/send",
    body: { tokens: { "{first_name}": "Ada" } },
  },
  {
    name: "mautic_send_email_to_segment",
    args: { email_id: 5, listIds: [2, 3] },
    method: "POST",
    path: "/api/emails/5/send",
    planPath: "api/emails/5/send",
    body: { listIds: [2, 3] },
  },
  {
    name: "mautic_add_contact_to_campaign",
    args: { campaign_id: 3, contact_id: 47 },
    method: "POST",
    path: "/api/campaigns/3/contact/47/add",
    planPath: "api/campaigns/3/contact/47/add",
    body: undefined,
  },
  {
    name: "mautic_remove_contact_from_campaign",
    args: { campaign_id: 3, contact_id: 47 },
    method: "POST",
    path: "/api/campaigns/3/contact/47/remove",
    planPath: "api/campaigns/3/contact/47/remove",
    body: undefined,
  },
  {
    name: "mautic_change_contact_stage",
    args: { stage_id: 4, contact_id: 47 },
    method: "POST",
    path: "/api/stages/4/contact/47/add",
    planPath: "api/stages/4/contact/47/add",
    body: undefined,
  },
  {
    name: "mautic_adjust_contact_points",
    args: { contact_id: 47, operation: "plus", points: 5, eventName: "Score via api", actionName: "Adding" },
    method: "POST",
    path: "/api/contacts/47/points/plus/5",
    planPath: "api/contacts/47/points/plus/5",
    body: { eventName: "Score via api", actionName: "Adding" },
  },
  {
    name: "mautic_create_note",
    args: { lead: 47, text: "Discussed the demo.", type: "general" },
    method: "POST",
    path: "/api/notes/new",
    planPath: "api/notes/new",
    body: { lead: 47, text: "Discussed the demo.", type: "general" },
  },
  {
    name: "mautic_add_contact_dnc",
    args: {
      contact_id: 47,
      channel: "email",
      reason: 3,
      channelId: 26,
      comments: "Unsubscribed via API",
    },
    method: "POST",
    path: "/api/contacts/47/dnc/email/add",
    planPath: "api/contacts/47/dnc/email/add",
    body: { reason: 3, channelId: 26, comments: "Unsubscribed via API" },
  },
  {
    name: "mautic_remove_contact_dnc",
    args: { contact_id: 47, channel: "sms" },
    method: "POST",
    path: "/api/contacts/47/dnc/sms/remove",
    planPath: "api/contacts/47/dnc/sms/remove",
    body: undefined,
  },
  {
    name: "mautic_delete_webhook",
    args: { webhook_id: 4 },
    method: "DELETE",
    path: "/api/hooks/4/delete",
    planPath: "api/hooks/4/delete",
    body: undefined,
  },
];

describe("write confirm gate", () => {
  it("rejects confirm values other than the boolean true at Zod", () => {
    expect(confirmField.safeParse(false).success).toBe(false);
    expect(confirmField.safeParse("true").success).toBe(false);
    expect(confirmField.safeParse(true).success).toBe(true);
    expect(confirmField.safeParse(undefined).success).toBe(true);
    expect(createContactInput.safeParse({ email: "a@b.com", confirm: false }).success).toBe(false);
    expect(createContactInput.safeParse({ email: "a@b.com", confirm: "true" }).success).toBe(false);
    expect(
      sendEmailToContactInput.safeParse({ email_id: 5, contact_id: 47, confirm: false }).success,
    ).toBe(false);
    expect(
      adjustContactPointsInput.safeParse({
        contact_id: 47,
        operation: "plus",
        points: 1,
        confirm: "true",
      }).success,
    ).toBe(false);
    expect(createNoteInput.safeParse({ lead: 47, text: "hi", confirm: false }).success).toBe(false);
  });

  for (const testCase of WRITE_CASES) {
    const label = `${testCase.name} ${testCase.method} ${testCase.path}`;

    it(`${label}: omit confirm previews and does not fetch`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: true }));
      await withTool(fetchImpl, {}, async (client) => {
        const result = readToolText(
          await client.callTool({ name: testCase.name, arguments: testCase.args }),
        );
        expect(result.isError).toBe(false);
        expect(calls).toHaveLength(0);
        const body = parseObject(result.text);
        expect(body["dryRun"]).toBe(true);
        expect(body["method"]).toBe(testCase.method);
        expect(body["path"]).toBe(testCase.planPath);
        if (testCase.body === undefined) expect(body["body"]).toBeUndefined();
        else expect(body["body"]).toEqual(testCase.body);
      });
    });

    it(`${label}: confirm true sends one authenticated call`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: true }));
      await withTool(fetchImpl, {}, async (client) => {
        const result = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: true },
          }),
        );
        expect(result.isError).toBe(false);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe(testCase.method);
        expect(pathOf(calls[0]?.url ?? "")).toBe(testCase.path);
        expect(calls[0]?.authorization).toBe(BASIC_HEADER);
        if (testCase.body === undefined) expect(calls[0]?.body).toBeUndefined();
        else expect(calls[0]?.body).toEqual(testCase.body);
        expect(parseObject(result.text)).toEqual({ success: true });
      });
    });

    it(`${label}: confirm false and string true are input errors with zero calls`, async () => {
      const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: true }));
      await withTool(fetchImpl, {}, async (client) => {
        const asFalse = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: false },
          }),
        );
        const asString = readToolText(
          await client.callTool({
            name: testCase.name,
            arguments: { ...testCase.args, confirm: "true" },
          }),
        );
        expect(asFalse.isError).toBe(true);
        expect(asString.isError).toBe(true);
        expect(asFalse.text.toLowerCase()).toMatch(/input|confirm|validation/);
        expect(asString.text.toLowerCase()).toMatch(/input|confirm|validation/);
        expect(calls).toHaveLength(0);
      });
    });
  }
});

describe("write extras", () => {
  it("adjusts points with minus and no event body", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: true }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_adjust_contact_points",
          arguments: { contact_id: 47, operation: "minus", points: 2, confirm: true },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls[0]?.method).toBe("POST");
      expect(pathOf(calls[0]?.url ?? "")).toBe("/api/contacts/47/points/minus/2");
      expect(calls[0]?.body).toBeUndefined();
    });
  });

  it("omitting confirm on oauth2 does not fetch a token", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 }),
    );
    const runtime = oauthRuntimeFor(fetchImpl);
    const { client, close } = await connectServer(runtime);
    try {
      const result = readToolText(
        await client.callTool({
          name: "mautic_create_contact",
          arguments: { email: "ada@example.com" },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls).toHaveLength(0);
      expect(parseObject(result.text)["dryRun"]).toBe(true);
    } finally {
      await close();
    }
  });

  it("sends camelCase point names for minus", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({ success: 1 }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_adjust_contact_points",
          arguments: {
            contact_id: 47,
            operation: "minus",
            points: 1,
            eventName: "Score via api",
            actionName: "Subtracting",
            confirm: true,
          },
        }),
      );
      expect(result.isError).toBe(false);
      expect(pathOf(calls[0]?.url ?? "")).toBe("/api/contacts/47/points/minus/1");
      expect(calls[0]?.body).toEqual({ eventName: "Score via api", actionName: "Subtracting" });
      expect(parseObject(result.text)).toEqual({ success: 1 });
    });
  });

  it("returns the live campaign add shape", async () => {
    const { fetchImpl } = jsonFetch(() => Response.json({ success: 1 }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_add_contact_to_campaign",
          arguments: { campaign_id: 2, contact_id: 9, confirm: true },
        }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({ success: 1 });
    });
  });

  it("returns the live segment send shape", async () => {
    const { fetchImpl } = jsonFetch(() =>
      Response.json({ success: 1, sentCount: 2, failedRecipients: 0 }),
    );
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_send_email_to_segment",
          arguments: { email_id: 2, confirm: true },
        }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({ success: 1, sentCount: 2, failedRecipients: 0 });
    });
  });
});

describe("live collection shapes", () => {
  it("normalizes an empty contact object and a string total", async () => {
    const { fetchImpl } = jsonFetch(() => Response.json({ total: "0", contacts: {} }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_search_contacts",
          arguments: { search: "email:nobody@example.invalid" },
        }),
      );
      expect(result.isError).toBe(false);
      expect(parseObject(result.text)).toEqual({
        total: 0,
        start: 0,
        limit: 30,
        items: [],
        nextStart: null,
      });
    });
  });

  it("normalizes form submissions when Mautic returns an array", async () => {
    const { fetchImpl } = jsonFetch(() =>
      Response.json({ total: "1", submissions: [{ id: 1, lead: { id: 7 } }] }),
    );
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({ name: "mautic_list_form_submissions", arguments: { form_id: 1 } }),
      );
      expect(parseObject(result.text)["items"]).toEqual([{ id: 1, lead: { id: 7 } }]);
    });
  });

  it("normalizes an empty stats array with a string total", async () => {
    const { fetchImpl } = jsonFetch(() => Response.json({ total: "0", stats: [] }));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_get_stats",
          arguments: { table: "email_stats", start: 0, limit: 1 },
        }),
      );
      expect(parseObject(result.text)).toMatchObject({ total: 0, items: [] });
    });
  });

  it("normalizes an empty webhook array and keeps a longer activity page", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url).endsWith("/hooks")) return Response.json({ total: 0, hooks: [] });
      return Response.json({
        events: [{ event: "a" }, { event: "b" }, { event: "c" }],
        total: 19,
        page: 1,
        limit: 2,
        maxPages: 3,
        filters: {},
        order: [],
        types: {},
      });
    });
    await withTool(fetchImpl, {}, async (client) => {
      const hooks = readToolText(await client.callTool({ name: "mautic_list_webhooks", arguments: {} }));
      expect(parseObject(hooks.text)).toMatchObject({ total: 0, items: [] });
      const activity = readToolText(
        await client.callTool({ name: "mautic_list_activity", arguments: { limit: 2 } }),
      );
      expect(parseObject(activity.text)).toMatchObject({
        total: 19,
        limit: 2,
        events: [{ event: "a" }, { event: "b" }, { event: "c" }],
      });
      expect(calls).toHaveLength(2);
    });
  });
});

describe("dnc and webhooks", () => {
  it("filters do-not-contact entries by channel", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({
        contact: {
          id: 9,
          doNotContact: [
            { id: 1, channel: "email", reason: 1, comments: "shape", channelId: 1 },
            { id: 2, channel: "sms", reason: 3, comments: "", channelId: null },
          ],
        },
      }),
    );
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_check_contact_dnc",
          arguments: { contact_id: 9, channel: "sms" },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls[0]?.authorization).toBe(BASIC_HEADER);
      expect(parseObject(result.text)).toEqual({
        contactId: "9",
        channel: "sms",
        entries: [{ id: 2, channel: "sms", reason: 3, comments: "", channelId: null }],
      });
    });
  });

  it("refetches do-not-contact after a confirmed add clears the cache", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (captured.method === "POST") {
        return Response.json({
          contact: {
            id: 9,
            doNotContact: [{ id: 1, channel: "email", reason: 3, comments: "", channelId: null }],
          },
        });
      }
      return Response.json({ contact: { id: 9, doNotContact: [] } });
    });
    await withTool(fetchImpl, { MAUTIC_CACHE_TTL_SEC: "60" }, async (client) => {
      await client.callTool({ name: "mautic_check_contact_dnc", arguments: { contact_id: 9 } });
      await client.callTool({ name: "mautic_check_contact_dnc", arguments: { contact_id: 9 } });
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
      const added = readToolText(
        await client.callTool({
          name: "mautic_add_contact_dnc",
          arguments: { contact_id: 9, channel: "email", confirm: true },
        }),
      );
      expect(added.isError).toBe(false);
      await client.callTool({
        name: "mautic_check_contact_dnc",
        arguments: { contact_id: 9, channel: "email" },
      });
      expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
    });
  });

  it("rejects a channel outside email and sms with zero calls", async () => {
    const { fetchImpl, calls } = jsonFetch(() => Response.json({}));
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_add_contact_dnc",
          arguments: { contact_id: 9, channel: "push", confirm: true },
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.text.toLowerCase()).toMatch(/input|channel/);
      expect(calls).toHaveLength(0);
    });
  });

  it("creates a webhook only after the trigger name is known and strips the secret", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      if (pathOf(captured.url).endsWith("/triggers")) {
        return Response.json({
          triggers: {
            "mautic.lead_post_save_new": { label: "Contact Identified Event", description: "Identified" },
          },
        });
      }
      return Response.json({
        hook: {
          id: 3,
          name: "Smoke",
          webhookUrl: "http://127.0.0.1:9/hook",
          secret: "hook-signing-secret-99",
          eventsOrderbyDir: "DESC",
          triggers: ["mautic.lead_post_save_new"],
        },
      });
    });
    const args = {
      name: "Smoke",
      webhookUrl: "http://127.0.0.1:9/hook",
      triggers: ["mautic.lead_post_save_new"],
      description: "Created via API",
      eventsOrderbyDir: "desc",
      isPublished: false,
    };
    await withTool(fetchImpl, {}, async (client) => {
      const dry = readToolText(await client.callTool({ name: "mautic_create_webhook", arguments: args }));
      expect(dry.isError).toBe(false);
      expect(calls).toHaveLength(0);
      expect(parseObject(dry.text)).toMatchObject({
        dryRun: true,
        method: "POST",
        path: "api/hooks/new",
        body: {
          name: "Smoke",
          webhookUrl: "http://127.0.0.1:9/hook",
          triggers: ["mautic.lead_post_save_new"],
          description: "Created via API",
          eventsOrderbyDir: "DESC",
          isPublished: false,
        },
      });
      const asFalse = readToolText(
        await client.callTool({ name: "mautic_create_webhook", arguments: { ...args, confirm: false } }),
      );
      const asString = readToolText(
        await client.callTool({
          name: "mautic_create_webhook",
          arguments: { ...args, confirm: "true" },
        }),
      );
      expect(asFalse.isError).toBe(true);
      expect(asString.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const created = readToolText(
        await client.callTool({
          name: "mautic_create_webhook",
          arguments: { ...args, confirm: true },
        }),
      );
      expect(created.isError).toBe(false);
      expect(created.text).not.toContain("hook-signing-secret-99");
      expect(parseObject(created.text)["hook"]).toEqual({
        id: 3,
        name: "Smoke",
        webhookUrl: "http://127.0.0.1:9/hook",
        eventsOrderbyDir: "DESC",
        triggers: ["mautic.lead_post_save_new"],
      });
      expect(calls.map((call) => `${call.method} ${pathOf(call.url)}`)).toEqual([
        "GET /api/hooks/triggers",
        "POST /api/hooks/new",
      ]);
      expect(calls[0]?.authorization).toBe(BASIC_HEADER);
      expect(calls[1]?.authorization).toBe(BASIC_HEADER);
      expect(calls[1]?.body).toEqual({
        name: "Smoke",
        webhookUrl: "http://127.0.0.1:9/hook",
        triggers: ["mautic.lead_post_save_new"],
        description: "Created via API",
        eventsOrderbyDir: "DESC",
        isPublished: false,
      });
    });
  });

  it("does not create a webhook when the trigger name is unknown", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({
        triggers: { "mautic.lead_post_save_new": { label: "New", description: "Identified" } },
      }),
    );
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_create_webhook",
          arguments: {
            name: "Bad",
            webhookUrl: "http://127.0.0.1:9/hook",
            triggers: ["not.a.real.trigger"],
            confirm: true,
          },
        }),
      );
      expect(result.isError).toBe(true);
      expect(result.text.toLowerCase()).toMatch(/input|trigger/);
      expect(calls).toHaveLength(1);
      expect(pathOf(calls[0]?.url ?? "")).toBe("/api/hooks/triggers");
    });
  });

  it("strips the secret from a deleted webhook", async () => {
    const { fetchImpl, calls } = jsonFetch(() =>
      Response.json({
        hook: { id: null, name: "Smoke", secret: "hook-signing-secret-99", webhookUrl: "http://127.0.0.1:9/hook" },
      }),
    );
    await withTool(fetchImpl, {}, async (client) => {
      const result = readToolText(
        await client.callTool({
          name: "mautic_delete_webhook",
          arguments: { webhook_id: 3, confirm: true },
        }),
      );
      expect(result.isError).toBe(false);
      expect(calls[0]?.method).toBe("DELETE");
      expect(calls[0]?.body).toBeUndefined();
      expect(calls[0]?.contentType).toBeNull();
      expect(result.text).not.toContain("hook-signing-secret-99");
      expect(parseObject(result.text)["hook"]).toEqual({
        id: null,
        name: "Smoke",
        webhookUrl: "http://127.0.0.1:9/hook",
      });
    });
  });
});
