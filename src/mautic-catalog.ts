import { z, type ZodRawShape, type ZodType } from "zod";
import { toolDescription, toolName } from "./brand.js";
import { DEFAULT_PAGE_LIMIT, HARD_MAX_LIMIT } from "./constants.js";
import { ConnectorError } from "./errors.js";
import {
  asToolResult,
  apiPath,
  clampLimit,
  contactDncEntries,
  definedBody,
  definedQuery,
  mauticObject,
  nestedQuery,
  toActivity,
  toPage,
  webhookPayload,
  webhookTriggers,
} from "./mautic-api.js";
import type { QueryMap } from "./http.js";
import type { Runtime } from "./runtime.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  READ_ONLY_REMOTE,
  WRITE_DESTRUCTIVE,
  WRITE_IDEMPOTENT,
  WRITE_NON_IDEMPOTENT,
  registerConnectorTool,
  type ToolSpec,
} from "./tools.js";
import { applyWrite, confirmField, previewWrite, type WritePlan } from "./write.js";
import { fixedError } from "./zod-messages.js";

const idError = fixedError("id must be a positive integer");
const startError = fixedError("start must be an integer >= 0");
const limitError = fixedError("limit must be an integer from 1 to 500");
const tableError = fixedError("table must be a letters, digits, and underscore name");
const opError = fixedError("operation must be plus or minus");
const noteTypeError = fixedError("type must be general, email, call, or meeting");
const pointsError = fixedError("points must be a positive integer");
const tagError = fixedError("each tag must be a non-empty string");

export const entityId = z
  .union([
    z.number({ error: idError }).int().positive(),
    z
      .string({ error: idError })
      .trim()
      .regex(/^[0-9]+$/, { error: idError }),
  ])
  .transform((value) => String(value));

const startField = z
  .number({ error: startError })
  .int()
  .min(0)
  .max(1_000_000)
  .default(0)
  .describe("Row offset. Defaults to 0.");

const limitField = z
  .number({ error: limitError })
  .int()
  .min(1)
  .max(HARD_MAX_LIMIT)
  .default(DEFAULT_PAGE_LIMIT)
  .describe("Page size. Defaults to 30. Capped by MAUTIC_MAX_LIMIT.");

const searchField = z
  .string()
  .trim()
  .max(500)
  .optional()
  .describe("Mautic search string or search command.");

const orderByField = z.string().trim().min(1).max(100).optional();
const orderByDirField = z.enum(["asc", "desc"]).optional();
const minimalField = z.boolean().optional();

const listInput = z.object({
  search: searchField,
  start: startField,
  limit: limitField,
  orderBy: orderByField,
  orderByDir: orderByDirField,
  minimal: minimalField,
});

type ListArgs = z.output<typeof listInput>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const tagList = z.array(z.string({ error: tagError }).trim().min(1).max(100)).min(1).max(50);

function listQuery(args: ListArgs, extra?: QueryMap): QueryMap | undefined {
  return definedQuery({
    search: args.search,
    start: args.start,
    limit: args.limit,
    orderBy: args.orderBy,
    orderByDir: args.orderByDir,
    minimal: args.minimal,
    ...extra,
  });
}

async function runList(
  runtime: Runtime,
  path: string,
  collectionKey: string,
  args: ListArgs,
  extra?: QueryMap,
  schema: ZodType<Record<string, unknown>> = mauticObject,
): Promise<Record<string, unknown>> {
  const limit = clampLimit(args.limit, runtime.config.maxLimit);
  const start = args.start;
  const raw = await runtime.client.getJson(
    {
      path,
      query: listQuery({ ...args, limit }, extra),
      ttlSec: runtime.cacheTtlSec,
    },
    schema,
  );
  return { ...toPage(raw, collectionKey, start, limit) };
}

async function runGet(
  runtime: Runtime,
  path: string,
  schema: ZodType<Record<string, unknown>> = mauticObject,
): Promise<Record<string, unknown>> {
  const raw = await runtime.client.getJson(
    { path, query: undefined, ttlSec: runtime.cacheTtlSec },
    schema,
  );
  return asToolResult(raw);
}

function runPlan(
  runtime: Runtime,
  confirm: true | undefined,
  plan: WritePlan,
): Promise<Record<string, unknown>> {
  return applyWrite(runtime.client, confirm, plan, mauticObject, asToolResult);
}

export const searchContactsInput = listInput;
export const getContactInput = z.object({
  contact_id: entityId.describe("Mautic contact ID."),
});
export const createContactInput = z.object({
  email: z.string().trim().max(320).optional(),
  firstname: z.string().trim().max(200).optional(),
  lastname: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  ipAddress: z.string().trim().min(1).max(80).optional(),
  owner: entityId.optional(),
  lastActive: z.string().trim().min(1).max(80).optional(),
  overwriteWithBlank: z.boolean().optional(),
  fields: z.record(z.string(), scalar).optional(),
  confirm: confirmField,
});
export const updateContactInput = createContactInput.extend({
  contact_id: entityId.describe("Mautic contact ID."),
});
export const contactTagsInput = z.object({
  contact_id: entityId,
  tags: tagList,
  confirm: confirmField,
});
export const listSegmentsInput = listInput;
export const segmentContactInput = z.object({
  segment_id: entityId,
  contact_id: entityId,
  confirm: confirmField,
});
export const listCompaniesInput = listInput;
export const getCompanyInput = z.object({ company_id: entityId });
export const createCompanyInput = z.object({
  companyname: z.string().trim().min(1).max(255),
  companyemail: z.string().trim().max(320).optional(),
  companyphone: z.string().trim().max(80).optional(),
  companywebsite: z.string().trim().max(500).optional(),
  companyaddress1: z.string().trim().max(255).optional(),
  companyaddress2: z.string().trim().max(255).optional(),
  companycity: z.string().trim().max(120).optional(),
  companystate: z.string().trim().max(120).optional(),
  companyzipcode: z.string().trim().max(40).optional(),
  companycountry: z.string().trim().max(120).optional(),
  companynumber_of_employees: z.number().int().min(0).optional(),
  companyfax: z.string().trim().max(80).optional(),
  companyannual_revenue: z.number().optional(),
  companyindustry: z.string().trim().max(120).optional(),
  companydescription: z.string().trim().max(5000).optional(),
  score: z.number().int().optional(),
  fields: z.record(z.string(), scalar).optional(),
  confirm: confirmField,
});
export const updateCompanyInput = createCompanyInput.extend({
  company_id: entityId,
  companyname: z.string().trim().min(1).max(255).optional(),
});
export const companyContactInput = z.object({
  company_id: entityId,
  contact_id: entityId,
  confirm: confirmField,
});
export const listEmailsInput = listInput;
export const getEmailInput = z.object({ email_id: entityId });
export const getEmailStatsInput = z.object({ email_id: entityId });
export const sendEmailToContactInput = z.object({
  email_id: entityId,
  contact_id: entityId,
  tokens: z.record(z.string(), z.string()).optional(),
  confirm: confirmField,
});
export const sendEmailToSegmentInput = z.object({
  email_id: entityId,
  listIds: z.array(entityId).min(1).max(100).optional(),
  confirm: confirmField,
});
export const listCampaignsInput = listInput;
export const getCampaignInput = z.object({ campaign_id: entityId });
export const campaignContactInput = z.object({
  campaign_id: entityId,
  contact_id: entityId,
  confirm: confirmField,
});
export const listFormsInput = listInput;
export const getFormInput = z.object({ form_id: entityId });
export const listFormSubmissionsInput = listInput.extend({
  form_id: entityId,
});
export const listStagesInput = listInput;
export const changeContactStageInput = z.object({
  stage_id: entityId,
  contact_id: entityId,
  confirm: confirmField,
});
export const adjustContactPointsInput = z.object({
  contact_id: entityId,
  operation: z.enum(["plus", "minus"], { error: opError }),
  points: z.number({ error: pointsError }).int().positive(),
  eventName: z.string().trim().min(1).max(200).optional(),
  actionName: z.string().trim().min(1).max(200).optional(),
  confirm: confirmField,
});
export const listPointTriggersInput = listInput;
export const listPointActionsInput = listInput;
export const listNotesInput = listInput.extend({
  contact_id: entityId.optional(),
});
export const createNoteInput = z.object({
  lead: entityId.describe("Contact ID for the note."),
  text: z.string().trim().min(1).max(20_000),
  type: z.enum(["general", "email", "call", "meeting"], { error: noteTypeError }).optional(),
  dateTime: z.string().trim().min(1).max(80).optional(),
  confirm: confirmField,
});
export const listReportsInput = listInput;
export const getReportInput = z.object({
  report_id: entityId,
  dateFrom: z.string().trim().min(1).max(40).optional(),
  dateTo: z.string().trim().min(1).max(40).optional(),
  limit: z
    .number({ error: limitError })
    .int()
    .min(1)
    .max(HARD_MAX_LIMIT)
    .optional()
    .describe("Page size. Capped by MAUTIC_MAX_LIMIT."),
  page: z.number().int().min(1).max(1_000_000).optional(),
});
export const listStatTablesInput = z.object({});
export const getStatsInput = z.object({
  table: z
    .string({ error: tableError })
    .trim()
    .regex(/^[A-Za-z0-9_]+$/, { error: tableError })
    .max(80),
  start: startField,
  limit: limitField,
  order: z
    .array(
      z.object({
        col: z.string().trim().min(1).max(80),
        dir: z.enum(["asc", "desc"]).optional(),
      }),
    )
    .max(20)
    .optional(),
  where: z
    .array(
      z.object({
        col: z.string().trim().min(1).max(80),
        expr: z.string().trim().min(1).max(40),
        val: z.union([z.string(), z.number(), z.boolean()]).optional(),
      }),
    )
    .max(20)
    .optional(),
});

const channelError = fixedError("channel must be email or sms");
const reasonError = fixedError("reason must be 1 (unsubscribed), 2 (bounced), or 3 (manual)");
const webhookUrlError = fixedError("webhookUrl must be an http or https URL");
const activityDateError = fixedError("date must use Y-m-d H:i:s");

const dncChannel = z.enum(["email", "sms"], { error: channelError });
const dncReason = z
  .union([z.literal(1), z.literal(2), z.literal(3)], { error: reasonError })
  .optional()
  .describe("1 unsubscribed, 2 bounced, 3 manual.");

const upperDir = {
  asc: "ASC",
  desc: "DESC",
  ASC: "ASC",
  DESC: "DESC",
} as const;

const upperDirField = z
  .enum(["asc", "desc", "ASC", "DESC"])
  .transform((value) => upperDir[value]);

const webhookUrlField = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    },
    { error: webhookUrlError },
  );

const activityDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, { error: activityDateError });

const eventNameList = z.array(z.string().trim().min(1).max(120)).max(50);

const activityFields = {
  search: searchField,
  includeEvents: eventNameList
    .optional()
    .describe("Event type names to include, sent as filters[includeEvents][]."),
  excludeEvents: eventNameList
    .optional()
    .describe("Event type names to exclude, sent as filters[excludeEvents][]."),
  dateFrom: activityDate.optional().describe("Start, Y-m-d H:i:s."),
  dateTo: activityDate.optional().describe("End, Y-m-d H:i:s."),
  order: z
    .tuple([z.string().trim().min(1).max(80), upperDirField])
    .optional()
    .describe("Sort column and direction. Sent as order[0] and order[1]."),
  page: z.number().int().min(1).max(1_000_000).optional(),
  limit: z
    .number({ error: limitError })
    .int()
    .min(1)
    .max(HARD_MAX_LIMIT)
    .optional()
    .describe("Page size. Capped by MAUTIC_MAX_LIMIT."),
};

export const checkContactDncInput = z.object({
  contact_id: entityId,
  channel: dncChannel.optional().describe("When set, only this channel's entries are returned."),
});
export const addContactDncInput = z.object({
  contact_id: entityId,
  channel: dncChannel.describe("DNC channel. email or sms."),
  reason: dncReason,
  channelId: entityId.optional().describe("ID of the entity that caused the entry."),
  comments: z.string().trim().max(5000).optional(),
  confirm: confirmField,
});
export const removeContactDncInput = z.object({
  contact_id: entityId,
  channel: dncChannel,
  confirm: confirmField,
});
export const listActivityInput = z.object(activityFields);
export const contactActivityInput = listActivityInput.extend({
  contact_id: entityId.describe("Mautic contact ID."),
});
export const listAssetsInput = listInput;
export const getAssetInput = z.object({ asset_id: entityId });
export const listWebhooksInput = listInput;
export const getWebhookInput = z.object({ webhook_id: entityId });
export const createWebhookInput = z.object({
  name: z.string().trim().min(1).max(255),
  webhookUrl: webhookUrlField,
  triggers: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  description: z.string().trim().max(5000).optional(),
  eventsOrderbyDir: upperDirField
    .optional()
    .describe("ASC or DESC. Lowercase asc and desc are accepted and sent in uppercase."),
  isPublished: z.boolean().optional(),
  confirm: confirmField,
});
export const deleteWebhookInput = z.object({
  webhook_id: entityId,
  confirm: confirmField,
});

type ActivityArgs = z.output<typeof listActivityInput>;

function activityQuery(args: ActivityArgs, maxLimit: number): QueryMap | undefined {
  const limit = args.limit === undefined ? undefined : clampLimit(args.limit, maxLimit);
  return definedQuery({
    "filters[search]": args.search,
    "filters[includeEvents][]": args.includeEvents,
    "filters[excludeEvents][]": args.excludeEvents,
    "filters[dateFrom]": args.dateFrom,
    "filters[dateTo]": args.dateTo,
    "order[0]": args.order?.[0],
    "order[1]": args.order?.[1],
    page: args.page,
    limit,
  });
}

async function runActivity(
  runtime: Runtime,
  path: string,
  args: ActivityArgs,
): Promise<Record<string, unknown>> {
  const raw = await runtime.client.getJson(
    {
      path,
      query: activityQuery(args, runtime.config.maxLimit),
      ttlSec: runtime.cacheTtlSec,
    },
    mauticObject,
  );
  return toActivity(raw);
}

function contactBody(
  args: z.output<typeof createContactInput>,
): Record<string, unknown> | undefined {
  return definedBody({
    ...(args.fields ?? {}),
    email: args.email,
    firstname: args.firstname,
    lastname: args.lastname,
    tags: args.tags,
    ipAddress: args.ipAddress,
    owner: args.owner === undefined ? undefined : Number(args.owner),
    lastActive: args.lastActive,
    overwriteWithBlank: args.overwriteWithBlank,
  });
}

function companyBody(args: {
  companyname?: string | undefined;
  companyemail?: string | undefined;
  companyphone?: string | undefined;
  companywebsite?: string | undefined;
  companyaddress1?: string | undefined;
  companyaddress2?: string | undefined;
  companycity?: string | undefined;
  companystate?: string | undefined;
  companyzipcode?: string | undefined;
  companycountry?: string | undefined;
  companynumber_of_employees?: number | undefined;
  companyfax?: string | undefined;
  companyannual_revenue?: number | undefined;
  companyindustry?: string | undefined;
  companydescription?: string | undefined;
  score?: number | undefined;
  fields?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}): Record<string, unknown> | undefined {
  return definedBody({
    ...(args.fields ?? {}),
    companyname: args.companyname,
    companyemail: args.companyemail,
    companyphone: args.companyphone,
    companywebsite: args.companywebsite,
    companyaddress1: args.companyaddress1,
    companyaddress2: args.companyaddress2,
    companycity: args.companycity,
    companystate: args.companystate,
    companyzipcode: args.companyzipcode,
    companycountry: args.companycountry,
    companynumber_of_employees: args.companynumber_of_employees,
    companyfax: args.companyfax,
    companyannual_revenue: args.companyannual_revenue,
    companyindustry: args.companyindustry,
    companydescription: args.companydescription,
    score: args.score,
  });
}

export function planCreateContact(args: z.output<typeof createContactInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "contacts", "new"),
    query: undefined,
    body: contactBody(args) ?? {},
    summary: "Create a contact via POST /api/contacts/new.",
  };
}

export function planUpdateContact(args: z.output<typeof updateContactInput>): WritePlan {
  return {
    kind: "request",
    method: "PATCH",
    path: apiPath("api", "contacts", args.contact_id, "edit"),
    query: undefined,
    body: contactBody(args) ?? {},
    summary: `Update contact ${args.contact_id} via PATCH /api/contacts/${args.contact_id}/edit.`,
  };
}

export function planAddContactTags(args: z.output<typeof contactTagsInput>): WritePlan {
  return {
    kind: "request",
    method: "PATCH",
    path: apiPath("api", "contacts", args.contact_id, "edit"),
    query: undefined,
    body: { tags: args.tags },
    summary: `Add tags on contact ${args.contact_id} via PATCH /api/contacts/${args.contact_id}/edit with tags.`,
  };
}

export function planRemoveContactTags(args: z.output<typeof contactTagsInput>): WritePlan {
  const tags = args.tags.map((tag) => (tag.startsWith("-") ? tag : `-${tag}`));
  return {
    kind: "request",
    method: "PATCH",
    path: apiPath("api", "contacts", args.contact_id, "edit"),
    query: undefined,
    body: { tags },
    summary: `Remove tags on contact ${args.contact_id} via PATCH /api/contacts/${args.contact_id}/edit with a -tag prefix.`,
  };
}

export function planAddContactToSegment(args: z.output<typeof segmentContactInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "segments", args.segment_id, "contact", args.contact_id, "add"),
    query: undefined,
    body: undefined,
    summary: `Add contact ${args.contact_id} to segment ${args.segment_id}.`,
  };
}

export function planRemoveContactFromSegment(
  args: z.output<typeof segmentContactInput>,
): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "segments", args.segment_id, "contact", args.contact_id, "remove"),
    query: undefined,
    body: undefined,
    summary: `Remove contact ${args.contact_id} from segment ${args.segment_id}.`,
  };
}

export function planCreateCompany(args: z.output<typeof createCompanyInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "companies", "new"),
    query: undefined,
    body: companyBody(args) ?? { companyname: args.companyname },
    summary: "Create a company via POST /api/companies/new.",
  };
}

export function planUpdateCompany(args: z.output<typeof updateCompanyInput>): WritePlan {
  return {
    kind: "request",
    method: "PATCH",
    path: apiPath("api", "companies", args.company_id, "edit"),
    query: undefined,
    body: companyBody(args) ?? {},
    summary: `Update company ${args.company_id} via PATCH /api/companies/${args.company_id}/edit.`,
  };
}

export function planAddContactToCompany(args: z.output<typeof companyContactInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "companies", args.company_id, "contact", args.contact_id, "add"),
    query: undefined,
    body: undefined,
    summary: `Add contact ${args.contact_id} to company ${args.company_id}.`,
  };
}

export function planRemoveContactFromCompany(
  args: z.output<typeof companyContactInput>,
): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "companies", args.company_id, "contact", args.contact_id, "remove"),
    query: undefined,
    body: undefined,
    summary: `Remove contact ${args.contact_id} from company ${args.company_id}.`,
  };
}

export function planSendEmailToContact(args: z.output<typeof sendEmailToContactInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "emails", args.email_id, "contact", args.contact_id, "send"),
    query: undefined,
    body: definedBody({ tokens: args.tokens }),
    summary: `Send email ${args.email_id} to contact ${args.contact_id}.`,
  };
}

export function planSendEmailToSegment(args: z.output<typeof sendEmailToSegmentInput>): WritePlan {
  const listIds = args.listIds?.map((id) => Number(id));
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "emails", args.email_id, "send"),
    query: undefined,
    body: definedBody({ listIds }),
    summary: `Send email ${args.email_id} to its segments via POST /api/emails/${args.email_id}/send.`,
  };
}

export function planAddContactToCampaign(args: z.output<typeof campaignContactInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "campaigns", args.campaign_id, "contact", args.contact_id, "add"),
    query: undefined,
    body: undefined,
    summary: `Add contact ${args.contact_id} to campaign ${args.campaign_id}.`,
  };
}

export function planRemoveContactFromCampaign(
  args: z.output<typeof campaignContactInput>,
): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "campaigns", args.campaign_id, "contact", args.contact_id, "remove"),
    query: undefined,
    body: undefined,
    summary: `Remove contact ${args.contact_id} from campaign ${args.campaign_id}.`,
  };
}

export function planChangeContactStage(args: z.output<typeof changeContactStageInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "stages", args.stage_id, "contact", args.contact_id, "add"),
    query: undefined,
    body: undefined,
    summary: `Move contact ${args.contact_id} to stage ${args.stage_id}.`,
  };
}

export function planAdjustContactPoints(args: z.output<typeof adjustContactPointsInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "contacts", args.contact_id, "points", args.operation, String(args.points)),
    query: undefined,
    // Mautic 7.2.1 reads eventName and actionName for both plus and minus.
    // The subtract docs' eventname and actionname are stored as the default names.
    body: definedBody({ eventName: args.eventName, actionName: args.actionName }),
    summary: `${args.operation === "plus" ? "Add" : "Subtract"} ${args.points} points on contact ${args.contact_id}.`,
  };
}

export function planCreateNote(args: z.output<typeof createNoteInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "notes", "new"),
    query: undefined,
    body: definedBody({
      lead: Number(args.lead),
      text: args.text,
      type: args.type,
      dateTime: args.dateTime,
    }),
    summary: `Create a note on contact ${args.lead} via POST /api/notes/new.`,
  };
}

export function planAddContactDnc(args: z.output<typeof addContactDncInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "contacts", args.contact_id, "dnc", args.channel, "add"),
    query: undefined,
    body: definedBody({
      reason: args.reason,
      channelId: args.channelId === undefined ? undefined : Number(args.channelId),
      comments: args.comments,
    }),
    summary: `Add ${args.channel} do-not-contact on contact ${args.contact_id}.`,
  };
}

export function planRemoveContactDnc(args: z.output<typeof removeContactDncInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "contacts", args.contact_id, "dnc", args.channel, "remove"),
    query: undefined,
    body: undefined,
    summary: `Remove ${args.channel} do-not-contact from contact ${args.contact_id}.`,
  };
}

export function planCreateWebhook(args: z.output<typeof createWebhookInput>): WritePlan {
  return {
    kind: "request",
    method: "POST",
    path: apiPath("api", "hooks", "new"),
    query: undefined,
    body: definedBody({
      name: args.name,
      webhookUrl: args.webhookUrl,
      triggers: [...args.triggers],
      description: args.description,
      eventsOrderbyDir: args.eventsOrderbyDir,
      isPublished: args.isPublished,
    }),
    summary: "Create a webhook via POST /api/hooks/new.",
  };
}

export function planDeleteWebhook(args: z.output<typeof deleteWebhookInput>): WritePlan {
  return {
    kind: "request",
    method: "DELETE",
    path: apiPath("api", "hooks", args.webhook_id, "delete"),
    query: undefined,
    body: undefined,
    summary: `Delete webhook ${args.webhook_id} via DELETE /api/hooks/${args.webhook_id}/delete.`,
  };
}

function emailCounts(raw: Record<string, unknown>): Record<string, unknown> {
  const nested = mauticObject.safeParse(raw["email"]);
  const email = nested.success ? nested.data : raw;
  return {
    sentCount: email["sentCount"],
    readCount: email["readCount"],
    variantSentCount: email["variantSentCount"],
    variantReadCount: email["variantReadCount"],
    email,
  };
}

export function registerMauticTools(server: McpServer, runtime: Runtime): void {
  const ctx = { secrets: runtime.secrets, logger: runtime.logger };
  const add = <Shape extends ZodRawShape>(spec: ToolSpec<Shape>): void => {
    registerConnectorTool(server, spec, ctx);
  };

  add({
    name: toolName("mautic_search_contacts"),
    description: toolDescription(
      "Search contacts. GET /api/contacts with search, start, limit, orderBy, orderByDir, minimal. Mautic search syntax includes email:*@example.com, tag:vip, and segment:alias.",
    ),
    inputSchema: searchContactsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "contacts"), "contacts", args),
  });
  add({
    name: toolName("mautic_get_contact"),
    description: toolDescription("Get one contact. GET /api/contacts/{id}."),
    inputSchema: getContactInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "contacts", args.contact_id)),
  });
  add({
    name: toolName("mautic_create_contact"),
    description: toolDescription(
      "Create a contact. POST /api/contacts/new. Omit confirm for a dry-run preview. confirm must be the boolean true to execute.",
    ),
    inputSchema: createContactInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planCreateContact(args)),
  });
  add({
    name: toolName("mautic_update_contact"),
    description: toolDescription(
      "Update a contact. PATCH /api/contacts/{id}/edit so a missing ID fails rather than creating. Omit confirm for a dry-run preview.",
    ),
    inputSchema: updateContactInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planUpdateContact(args)),
  });
  add({
    name: toolName("mautic_add_contact_tags"),
    description: toolDescription(
      "Add tags on a contact. PATCH /api/contacts/{id}/edit with body tags as an array of tag names. Omit confirm for a dry-run preview.",
    ),
    inputSchema: contactTagsInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAddContactTags(args)),
  });
  add({
    name: toolName("mautic_remove_contact_tags"),
    description: toolDescription(
      "Remove tags from a contact. PATCH /api/contacts/{id}/edit with tags prefixed by minus, for example -vip. Pass the tag name without the prefix. Omit confirm for a dry-run preview.",
    ),
    inputSchema: contactTagsInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) => runPlan(runtime, args.confirm, planRemoveContactTags(args)),
  });
  add({
    name: toolName("mautic_list_segments"),
    description: toolDescription(
      "List segments. GET /api/segments. The collection key in the Mautic body is lists.",
    ),
    inputSchema: listSegmentsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "segments"), "lists", args),
  });
  add({
    name: toolName("mautic_add_contact_to_segment"),
    description: toolDescription(
      "Add a contact to a segment. POST /api/segments/{segmentId}/contact/{contactId}/add. Omit confirm for a dry-run preview.",
    ),
    inputSchema: segmentContactInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAddContactToSegment(args)),
  });
  add({
    name: toolName("mautic_remove_contact_from_segment"),
    description: toolDescription(
      "Remove a contact from a segment. POST /api/segments/{segmentId}/contact/{contactId}/remove. Omit confirm for a dry-run preview.",
    ),
    inputSchema: segmentContactInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) => runPlan(runtime, args.confirm, planRemoveContactFromSegment(args)),
  });
  add({
    name: toolName("mautic_list_companies"),
    description: toolDescription("List companies. GET /api/companies."),
    inputSchema: listCompaniesInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "companies"), "companies", args),
  });
  add({
    name: toolName("mautic_get_company"),
    description: toolDescription("Get one company. GET /api/companies/{id}."),
    inputSchema: getCompanyInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "companies", args.company_id)),
  });
  add({
    name: toolName("mautic_create_company"),
    description: toolDescription(
      "Create a company. POST /api/companies/new. companyname is required. Omit confirm for a dry-run preview.",
    ),
    inputSchema: createCompanyInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planCreateCompany(args)),
  });
  add({
    name: toolName("mautic_update_company"),
    description: toolDescription(
      "Update a company. PATCH /api/companies/{id}/edit. Omit confirm for a dry-run preview.",
    ),
    inputSchema: updateCompanyInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planUpdateCompany(args)),
  });
  add({
    name: toolName("mautic_add_contact_to_company"),
    description: toolDescription(
      "Add a contact to a company. POST /api/companies/{companyId}/contact/{contactId}/add. Omit confirm for a dry-run preview.",
    ),
    inputSchema: companyContactInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAddContactToCompany(args)),
  });
  add({
    name: toolName("mautic_remove_contact_from_company"),
    description: toolDescription(
      "Remove a contact from a company. POST /api/companies/{companyId}/contact/{contactId}/remove. Omit confirm for a dry-run preview.",
    ),
    inputSchema: companyContactInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) => runPlan(runtime, args.confirm, planRemoveContactFromCompany(args)),
  });
  add({
    name: toolName("mautic_list_emails"),
    description: toolDescription("List emails. GET /api/emails."),
    inputSchema: listEmailsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "emails"), "emails", args),
  });
  add({
    name: toolName("mautic_get_email"),
    description: toolDescription("Get one email. GET /api/emails/{id}."),
    inputSchema: getEmailInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "emails", args.email_id)),
  });
  add({
    name: toolName("mautic_get_email_stats"),
    description: toolDescription(
      "Get email send and read counts from GET /api/emails/{id} (sentCount, readCount, variantSentCount, variantReadCount). Row-level stats are mautic_get_stats with table email_stats.",
    ),
    inputSchema: getEmailStatsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => {
      const raw = await runtime.client.getJson(
        {
          path: apiPath("api", "emails", args.email_id),
          query: undefined,
          ttlSec: runtime.cacheTtlSec,
        },
        mauticObject,
      );
      return emailCounts(raw);
    },
  });
  add({
    name: toolName("mautic_send_email_to_contact"),
    description: toolDescription(
      "Send an email to one contact. POST /api/emails/{id}/contact/{contactId}/send with optional tokens. Omit confirm for a dry-run preview.",
    ),
    inputSchema: sendEmailToContactInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planSendEmailToContact(args)),
  });
  add({
    name: toolName("mautic_send_email_to_segment"),
    description: toolDescription(
      "Send a segment email to its lists. POST /api/emails/{id}/send with optional listIds. Omit confirm for a dry-run preview.",
    ),
    inputSchema: sendEmailToSegmentInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planSendEmailToSegment(args)),
  });
  add({
    name: toolName("mautic_list_campaigns"),
    description: toolDescription("List campaigns. GET /api/campaigns."),
    inputSchema: listCampaignsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "campaigns"), "campaigns", args),
  });
  add({
    name: toolName("mautic_get_campaign"),
    description: toolDescription("Get one campaign. GET /api/campaigns/{id}."),
    inputSchema: getCampaignInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "campaigns", args.campaign_id)),
  });
  add({
    name: toolName("mautic_add_contact_to_campaign"),
    description: toolDescription(
      "Add a contact to a campaign. POST /api/campaigns/{campaignId}/contact/{contactId}/add. Omit confirm for a dry-run preview.",
    ),
    inputSchema: campaignContactInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAddContactToCampaign(args)),
  });
  add({
    name: toolName("mautic_remove_contact_from_campaign"),
    description: toolDescription(
      "Remove a contact from a campaign. POST /api/campaigns/{campaignId}/contact/{contactId}/remove. Omit confirm for a dry-run preview.",
    ),
    inputSchema: campaignContactInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) => runPlan(runtime, args.confirm, planRemoveContactFromCampaign(args)),
  });
  add({
    name: toolName("mautic_list_forms"),
    description: toolDescription("List forms. GET /api/forms."),
    inputSchema: listFormsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "forms"), "forms", args),
  });
  add({
    name: toolName("mautic_get_form"),
    description: toolDescription("Get one form. GET /api/forms/{id}."),
    inputSchema: getFormInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "forms", args.form_id)),
  });
  add({
    name: toolName("mautic_list_form_submissions"),
    description: toolDescription(
      "List submissions for a form. GET /api/forms/{formId}/submissions.",
    ),
    inputSchema: listFormSubmissionsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) =>
      runList(runtime, apiPath("api", "forms", args.form_id, "submissions"), "submissions", args),
  });
  add({
    name: toolName("mautic_list_stages"),
    description: toolDescription("List stages. GET /api/stages."),
    inputSchema: listStagesInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "stages"), "stages", args),
  });
  add({
    name: toolName("mautic_change_contact_stage"),
    description: toolDescription(
      "Add a contact to a stage. POST /api/stages/{stageId}/contact/{contactId}/add. Omit confirm for a dry-run preview.",
    ),
    inputSchema: changeContactStageInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planChangeContactStage(args)),
  });
  add({
    name: toolName("mautic_adjust_contact_points"),
    description: toolDescription(
      "Add or subtract contact points. POST /api/contacts/{id}/points/plus/{points} or /points/minus/{points} with optional eventName and actionName. Omit confirm for a dry-run preview.",
    ),
    inputSchema: adjustContactPointsInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAdjustContactPoints(args)),
  });
  add({
    name: toolName("mautic_list_point_triggers"),
    description: toolDescription("List point triggers. GET /api/points/triggers."),
    inputSchema: listPointTriggersInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) =>
      runList(runtime, apiPath("api", "points", "triggers"), "triggers", args),
  });
  add({
    name: toolName("mautic_list_point_actions"),
    description: toolDescription("List point actions. GET /api/points."),
    inputSchema: listPointActionsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "points"), "points", args),
  });
  add({
    name: toolName("mautic_list_notes"),
    description: toolDescription(
      "List notes. GET /api/notes, or GET /api/contacts/{id}/notes when contact_id is set.",
    ),
    inputSchema: listNotesInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => {
      const path =
        args.contact_id === undefined
          ? apiPath("api", "notes")
          : apiPath("api", "contacts", args.contact_id, "notes");
      return runList(runtime, path, "notes", args);
    },
  });
  add({
    name: toolName("mautic_create_note"),
    description: toolDescription(
      "Create a note. POST /api/notes/new with lead, text, and optional type (general, email, call, meeting). Omit confirm for a dry-run preview.",
    ),
    inputSchema: createNoteInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planCreateNote(args)),
  });
  add({
    name: toolName("mautic_list_reports"),
    description: toolDescription("List reports. GET /api/reports."),
    inputSchema: listReportsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "reports"), "reports", args),
  });
  add({
    name: toolName("mautic_get_report"),
    description: toolDescription(
      "Get one report. GET /api/reports/{id} with optional dateFrom, dateTo, limit, and page.",
    ),
    inputSchema: getReportInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => {
      const limit =
        args.limit === undefined ? undefined : clampLimit(args.limit, runtime.config.maxLimit);
      const raw = await runtime.client.getJson(
        {
          path: apiPath("api", "reports", args.report_id),
          query: definedQuery({
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            limit,
            page: args.page,
          }),
          ttlSec: runtime.cacheTtlSec,
        },
        mauticObject,
      );
      return asToolResult(raw);
    },
  });
  add({
    name: toolName("mautic_list_stat_tables"),
    description: toolDescription("List available stats tables. GET /api/stats."),
    inputSchema: listStatTablesInput,
    annotations: READ_ONLY_REMOTE,
    handler: async () => runGet(runtime, apiPath("api", "stats")),
  });
  add({
    name: toolName("mautic_get_stats"),
    description: toolDescription(
      "Read rows from a stats table. GET /api/stats/{table} with start, limit, order, and where.",
    ),
    inputSchema: getStatsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => {
      const limit = clampLimit(args.limit, runtime.config.maxLimit);
      const extra = {
        ...nestedQuery("order", args.order ?? []),
        ...nestedQuery("where", args.where ?? []),
      };
      const raw = await runtime.client.getJson(
        {
          path: apiPath("api", "stats", args.table),
          query: definedQuery({ start: args.start, limit, ...extra }),
          ttlSec: runtime.cacheTtlSec,
        },
        mauticObject,
      );
      return { ...toPage(raw, "stats", args.start, limit) };
    },
  });
  add({
    name: toolName("mautic_check_contact_dnc"),
    description: toolDescription(
      "Read a contact's doNotContact entries. GET /api/contacts/{id}. Optional channel keeps only that channel. DNC writes clear the read cache.",
    ),
    inputSchema: checkContactDncInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => {
      const raw = await runtime.client.getJson(
        {
          path: apiPath("api", "contacts", args.contact_id),
          query: undefined,
          ttlSec: runtime.cacheTtlSec,
        },
        mauticObject,
      );
      return {
        contactId: args.contact_id,
        channel: args.channel ?? null,
        entries: contactDncEntries(raw, args.channel),
      };
    },
  });
  add({
    name: toolName("mautic_add_contact_dnc"),
    description: toolDescription(
      "Add a do-not-contact entry. POST /api/contacts/{id}/dnc/{channel}/add with optional reason (1 unsubscribed, 2 bounced, 3 manual), channelId, and comments. Omit confirm for a dry-run preview.",
    ),
    inputSchema: addContactDncInput,
    annotations: WRITE_IDEMPOTENT,
    handler: async (args) => runPlan(runtime, args.confirm, planAddContactDnc(args)),
  });
  add({
    name: toolName("mautic_remove_contact_dnc"),
    description: toolDescription(
      "Remove a do-not-contact entry. POST /api/contacts/{id}/dnc/{channel}/remove. Omit confirm for a dry-run preview.",
    ),
    inputSchema: removeContactDncInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) => runPlan(runtime, args.confirm, planRemoveContactDnc(args)),
  });
  add({
    name: toolName("mautic_get_contact_activity"),
    description: toolDescription(
      "List activity for one contact. GET /api/contacts/{id}/activity with filters[search], filters[includeEvents][], filters[excludeEvents][], filters[dateFrom], filters[dateTo], order[0], order[1], page, and limit.",
    ),
    inputSchema: contactActivityInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) =>
      runActivity(runtime, apiPath("api", "contacts", args.contact_id, "activity"), args),
  });
  add({
    name: toolName("mautic_list_activity"),
    description: toolDescription(
      "List activity for all contacts. GET /api/contacts/activity with filters[search], filters[includeEvents][], filters[excludeEvents][], filters[dateFrom], filters[dateTo], order[0], order[1], page, and limit.",
    ),
    inputSchema: listActivityInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runActivity(runtime, apiPath("api", "contacts", "activity"), args),
  });
  add({
    name: toolName("mautic_list_assets"),
    description: toolDescription("List assets. GET /api/assets with search, start, limit, orderBy, and orderByDir."),
    inputSchema: listAssetsInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runList(runtime, apiPath("api", "assets"), "assets", args),
  });
  add({
    name: toolName("mautic_get_asset"),
    description: toolDescription("Get one asset. GET /api/assets/{id}."),
    inputSchema: getAssetInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) => runGet(runtime, apiPath("api", "assets", args.asset_id)),
  });
  add({
    name: toolName("mautic_list_webhook_triggers"),
    description: toolDescription(
      "List webhook trigger names. GET /api/hooks/triggers. Each row has name, label, and description.",
    ),
    inputSchema: z.object({}),
    annotations: READ_ONLY_REMOTE,
    handler: async () => {
      const raw = await runtime.client.getJson(
        { path: apiPath("api", "hooks", "triggers"), query: undefined, ttlSec: runtime.cacheTtlSec },
        mauticObject,
      );
      return { triggers: webhookTriggers(raw) };
    },
  });
  add({
    name: toolName("mautic_list_webhooks"),
    description: toolDescription(
      "List webhooks. GET /api/hooks. The signing secret field is removed from every webhook before the result is returned or cached.",
    ),
    inputSchema: listWebhooksInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) =>
      runList(runtime, apiPath("api", "hooks"), "hooks", args, undefined, webhookPayload),
  });
  add({
    name: toolName("mautic_get_webhook"),
    description: toolDescription(
      "Get one webhook. GET /api/hooks/{id}. The signing secret field is removed before the result is returned or cached.",
    ),
    inputSchema: getWebhookInput,
    annotations: READ_ONLY_REMOTE,
    handler: async (args) =>
      runGet(runtime, apiPath("api", "hooks", args.webhook_id), webhookPayload),
  });
  add({
    name: toolName("mautic_create_webhook"),
    description: toolDescription(
      "Create a webhook. POST /api/hooks/new with name, webhookUrl, and triggers. Optional description, eventsOrderbyDir (ASC or DESC), and isPublished. When confirm is true, trigger names are checked against GET /api/hooks/triggers before the create. Omit confirm for a dry-run preview that does not call Mautic. The response secret is removed.",
    ),
    inputSchema: createWebhookInput,
    annotations: WRITE_NON_IDEMPOTENT,
    handler: async (args) => {
      const plan = planCreateWebhook(args);
      if (args.confirm !== true) return previewWrite(plan);
      const listed = await runtime.client.getJson(
        { path: apiPath("api", "hooks", "triggers"), query: undefined, ttlSec: runtime.cacheTtlSec },
        mauticObject,
      );
      const known = new Set(webhookTriggers(listed).map((trigger) => trigger.name));
      const unknown = args.triggers.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        throw new ConnectorError("input", `Unknown webhook trigger (${unknown.join(", ")}).`);
      }
      return applyWrite(runtime.client, true, plan, webhookPayload, asToolResult);
    },
  });
  add({
    name: toolName("mautic_delete_webhook"),
    description: toolDescription(
      "Delete a webhook. DELETE /api/hooks/{id}/delete. Omit confirm for a dry-run preview. The response secret is removed.",
    ),
    inputSchema: deleteWebhookInput,
    annotations: WRITE_DESTRUCTIVE,
    handler: async (args) =>
      applyWrite(runtime.client, args.confirm, planDeleteWebhook(args), webhookPayload, asToolResult),
  });
}

export const TOOL_COUNT = 50;
