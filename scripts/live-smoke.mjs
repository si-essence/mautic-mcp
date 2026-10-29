#!/usr/bin/env node
/**
 * Sequential live smoke of the built stdio server.
 * Requests stay one-at-a-time because the PHP server is single-threaded.
 * Cache TTL is 0 so a dry-run "unchanged" check cannot be served from cache.
 * Output is redacted. Do not print tool payloads.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2];
const seeds = JSON.parse(readFileSync("/workspace/mautic-live/seed-ids.json", "utf8"));
const stamp = Date.now();
const email = `smoke-live-${stamp}@example.invalid`;
const contactName = "Smoke Test";
const companyName = `Smoke Co ${stamp}`;
const tag = `smoke-${stamp}`;
const oauthTag = `smoke-oauth-${stamp}`;
const noteText = `Smoke note ${stamp}`;
const hookName = `Smoke hook ${stamp}`;
const hookUrl = "http://127.0.0.1:9/hook";
const city = "Smokeville";

/** @type {string[]} */
const secretValues = [];
for (const key of ["MAUTIC_PASSWORD", "MAUTIC_CLIENT_SECRET", "MAUTIC_CLIENT_ID"]) {
  const value = process.env[key];
  if (typeof value === "string" && value.length >= 8) secretValues.push(value);
}
const basicUser = process.env["MAUTIC_USERNAME"];
const basicPass = process.env["MAUTIC_PASSWORD"];
if (typeof basicUser === "string" && typeof basicPass === "string" && basicPass.length >= 8) {
  secretValues.push(Buffer.from(`${basicUser}:${basicPass}`).toString("base64"));
}

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secretValues) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]");
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic [redacted]");
  out = out.replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"[redacted]"');
  out = out.replace(/"client_secret"\s*:\s*"[^"]*"/g, '"client_secret":"[redacted]"');
  out = out.replace(/"password"\s*:\s*"[^"]*"/g, '"password":"[redacted]"');
  out = out.replace(/"secret"\s*:\s*"(?:\\.|[^"\\])*"/g, '"secret":"[stripped]"');
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = false;
/** @type {Set<string>} */
const seen = new Set();

/**
 * @param {string} name
 * @param {"PASS" | "FAIL"} status
 * @param {string} reason
 */
function record(name, status, reason) {
  if (seen.has(name)) {
    failed = true;
    console.log(`${name} FAIL duplicate result`);
    return;
  }
  seen.add(name);
  if (status !== "PASS") failed = true;
  console.log(`${name} ${status} ${clip(reason)}`);
}

process.on("uncaughtException", (error) => {
  console.log(`startup FAIL ${clip(error instanceof Error ? error.message : "failed")}`);
  process.exit(1);
});

if (mode !== "basic" && mode !== "oauth") {
  console.log("startup FAIL mode must be basic or oauth");
  process.exit(2);
}

const baseUrl = process.env["MAUTIC_BASE_URL"] ?? "";
if (!baseUrl.startsWith("http://127.0.0.1:8080")) {
  console.log("startup FAIL MAUTIC_BASE_URL is not the local Mautic");
  process.exit(2);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} depth
 */
function hasSecretKey(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasSecretKey(item, depth + 1));
  return Object.entries(value).some(
    ([key, child]) => key === "secret" || hasSecretKey(child, depth + 1),
  );
}

/**
 * @param {unknown} json
 * @param {string} key
 */
function unwrap(json, key) {
  if (isRecord(json) && isRecord(json[key])) return json[key];
  return isRecord(json) ? json : {};
}

/**
 * @param {unknown} json
 * @param {string} key
 */
function idOf(json, key) {
  const entity = unwrap(json, key);
  if (entity["id"] === undefined || entity["id"] === null) return undefined;
  const id = String(entity["id"]);
  if (!/^[0-9]+$/.test(id) || id === "0") return undefined;
  return id;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 */
function sameId(left, right) {
  return String(left) === String(right);
}

/**
 * @param {unknown} json
 */
function itemsOf(json) {
  if (!isRecord(json) || !Array.isArray(json["items"])) return null;
  return json["items"].filter(isRecord);
}

/**
 * @param {Record<string, unknown>} entity
 * @param {string} alias
 */
function fieldValue(entity, alias) {
  const fields = entity["fields"];
  if (!isRecord(fields)) return undefined;
  const all = fields["all"];
  if (isRecord(all) && Object.prototype.hasOwnProperty.call(all, alias)) {
    const value = all[alias];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  }
  for (const bag of Object.values(fields)) {
    if (!isRecord(bag)) continue;
    const row = bag[alias];
    if (isRecord(row) && "value" in row) return row["value"];
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} entity
 * @param {string} alias
 */
function textField(entity, alias) {
  const nested = fieldValue(entity, alias);
  if (typeof nested === "string") return nested;
  const top = entity[alias];
  return typeof top === "string" ? top : undefined;
}

/**
 * @param {Record<string, unknown>} entity
 */
function tagNames(entity) {
  if (!Array.isArray(entity["tags"])) return [];
  /** @type {string[]} */
  const names = [];
  for (const tagRow of entity["tags"]) {
    if (typeof tagRow === "string") names.push(tagRow);
    else if (isRecord(tagRow) && typeof tagRow["tag"] === "string") names.push(tagRow["tag"]);
  }
  return names;
}

/**
 * @param {Record<string, unknown>} entity
 */
function stageId(entity) {
  if (!isRecord(entity["stage"])) return null;
  const id = entity["stage"]["id"];
  if (id === undefined || id === null) return null;
  return String(id);
}

/**
 * @param {Record<string, unknown>} entity
 */
function pointsOf(entity) {
  const value = entity["points"];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return Number(value);
  return null;
}

/**
 * @param {Record<string, unknown>} json
 * @param {string} key
 */
function countOf(json, key) {
  const value = json[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
}

/**
 * @param {unknown} json
 */
function successError(json) {
  if (!isRecord(json) || !Object.prototype.hasOwnProperty.call(json, "success")) return null;
  const flag = json["success"];
  if (flag === true || flag === 1 || flag === "1") return null;
  if (typeof flag === "string" || typeof flag === "number" || typeof flag === "boolean") {
    return `success=${String(flag)}`;
  }
  return "success not a flag";
}

const state = {
  contactId: /** @type {string | undefined} */ (undefined),
  companyId: /** @type {string | undefined} */ (undefined),
  webhookId: /** @type {string | undefined} */ (undefined),
  tagOn: false,
  inSegment: false,
  inCompany: false,
  inCampaign: false,
  dncOn: false,
  oauthTagOn: false,
  segmentAlias: "",
  triggerName: "",
};

/** @type {Client | undefined} */
let client;

/**
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 */
async function call(name, args = {}) {
  if (!client) return { ok: false, error: "client not connected", json: null };
  let result;
  try {
    result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "call failed";
    return { ok: false, error: clip(message), json: null };
  }
  const content = isRecord(result) && Array.isArray(result["content"]) ? result["content"] : [];
  const text = content
    .filter(
      (block) => isRecord(block) && block["type"] === "text" && typeof block["text"] === "string",
    )
    .map((block) => /** @type {string} */ (block["text"]))
    .join("\n");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json !== null && hasSecretKey(json)) {
    return { ok: false, error: "response contained a secret field", json: null };
  }
  if (isRecord(result) && result["isError"] === true) {
    return { ok: false, error: clip(text || "tool error"), json: null };
  }
  if (!isRecord(json)) return { ok: false, error: "response was not a JSON object", json: null };
  return { ok: true, error: "", json };
}

/**
 * @param {unknown} res
 * @param {string} method
 * @param {string} pathPart
 */
function dryError(res, method, pathPart) {
  if (!isRecord(res) || res["ok"] !== true || !isRecord(res["json"])) {
    return isRecord(res) && typeof res["error"] === "string" ? res["error"] : "dry-run failed";
  }
  const json = res["json"];
  if (json["dryRun"] !== true) return "dry-run preview missing";
  if (json["method"] !== method) return "dry-run method mismatch";
  if (!String(json["path"] ?? "").includes(pathPart)) return "dry-run path mismatch";
  return null;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {(json: Record<string, unknown>) => string | null} validate
 * @param {(json: Record<string, unknown>) => string} passReason
 */
async function expectRead(name, args, validate, passReason) {
  const res = await call(name, args);
  if (!res.ok || !res.json) return record(name, "FAIL", res.error || "empty");
  const err = validate(res.json);
  if (err) return record(name, "FAIL", err);
  return record(name, "PASS", passReason(res.json));
}

/**
 * @param {string} name
 * @param {{
 *   args: Record<string, unknown>;
 *   method: string;
 *   pathPart: string;
 *   checkDry?: (json: Record<string, unknown>) => string | null;
 *   unchanged: () => Promise<string | null>;
 *   onConfirmed?: (json: Record<string, unknown>) => void;
 *   effect: (json: Record<string, unknown>) => Promise<string | null>;
 *   reason: string;
 * }} spec
 */
async function confirmWrite(name, spec) {
  const dry = await call(name, spec.args);
  const previewErr = dryError(dry, spec.method, spec.pathPart);
  if (previewErr) return record(name, "FAIL", `dry-run: ${previewErr}`);
  if (spec.checkDry && dry.json) {
    const bodyErr = spec.checkDry(dry.json);
    if (bodyErr) return record(name, "FAIL", `dry-run: ${bodyErr}`);
  }
  const sameErr = await spec.unchanged();
  if (sameErr) return record(name, "FAIL", `dry-run left a change: ${sameErr}`);
  const live = await call(name, { ...spec.args, confirm: true });
  if (!live.ok || !live.json) return record(name, "FAIL", `confirm: ${live.error}`);
  if (live.json["dryRun"] === true) return record(name, "FAIL", "confirm returned a dry-run");
  const flagErr = successError(live.json);
  if (flagErr) return record(name, "FAIL", flagErr);
  if (spec.onConfirmed) spec.onConfirmed(live.json);
  const effectErr = await spec.effect(live.json);
  if (effectErr) return record(name, "FAIL", `effect: ${effectErr}`);
  return record(name, "PASS", spec.reason);
}

async function contactTotal() {
  const res = await call("mautic_search_contacts", { limit: 1, start: 0 });
  if (!res.ok || !res.json || typeof res.json["total"] !== "number") {
    return {
      error: res.error || "contact total missing",
      total: /** @type {number | null} */ (null),
    };
  }
  return {
    error: /** @type {string | null} */ (null),
    total: /** @type {number} */ (res.json["total"]),
  };
}

/**
 * @param {string} id
 */
async function loadContact(id) {
  const res = await call("mautic_get_contact", { contact_id: id });
  if (!res.ok || !res.json)
    return { error: res.error, contact: /** @type {Record<string, unknown> | null} */ (null) };
  return { error: null, contact: unwrap(res.json, "contact") };
}

/**
 * @param {string} id
 */
async function loadCompany(id) {
  const res = await call("mautic_get_company", { company_id: id });
  if (!res.ok || !res.json)
    return { error: res.error, company: /** @type {Record<string, unknown> | null} */ (null) };
  return { error: null, company: unwrap(res.json, "company") };
}

/**
 * @param {string} id
 */
async function emailSent(id) {
  const res = await call("mautic_get_email_stats", { email_id: id });
  if (!res.ok || !res.json) return { error: res.error, count: /** @type {number | null} */ (null) };
  const count = countOf(res.json, "sentCount");
  if (count === null) return { error: "sentCount missing", count };
  return { error: null, count };
}

/**
 * @param {string} table
 * @param {Array<Record<string, unknown>>} where
 */
async function statsRows(table, where) {
  const res = await call("mautic_get_stats", { table, start: 0, limit: 50, where });
  if (!res.ok || !res.json)
    return { error: res.error, items: /** @type {Record<string, unknown>[] | null} */ (null) };
  const items = itemsOf(res.json);
  if (!items) return { error: "stats items missing", items };
  return { error: null, items };
}

/**
 * @param {string} search
 */
async function segmentMembers(search) {
  const res = await call("mautic_search_contacts", { search, limit: 100, start: 0 });
  if (!res.ok || !res.json) return { error: res.error, ids: /** @type {string[] | null} */ (null) };
  const items = itemsOf(res.json);
  if (!items) return { error: "segment search items missing", ids: null };
  return { error: null, ids: items.map((item) => String(item["id"])) };
}

async function webhookTotal() {
  const res = await call("mautic_list_webhooks", { limit: 30, start: 0 });
  if (!res.ok || !res.json || typeof res.json["total"] !== "number") {
    return {
      error: res.error || "webhook total missing",
      total: /** @type {number | null} */ (null),
    };
  }
  return { error: null, total: /** @type {number} */ (res.json["total"]) };
}

async function companyTotal() {
  const res = await call("mautic_list_companies", { limit: 1, start: 0 });
  if (!res.ok || !res.json || typeof res.json["total"] !== "number") {
    return {
      error: res.error || "company total missing",
      total: /** @type {number | null} */ (null),
    };
  }
  return { error: null, total: /** @type {number} */ (res.json["total"]) };
}

/**
 * @param {string} contactId
 */
async function notePresent(contactId) {
  const res = await call("mautic_list_notes", { contact_id: contactId, limit: 50, start: 0 });
  if (!res.ok || !res.json) return { error: res.error, present: false };
  const items = itemsOf(res.json);
  if (!items) return { error: "notes items missing", present: false };
  const present = items.some((item) => item["text"] === noteText);
  return { error: null, present };
}

/**
 * @param {string} contactId
 */
async function emailDnc(contactId) {
  const res = await call("mautic_check_contact_dnc", { contact_id: contactId, channel: "email" });
  if (!res.ok || !res.json || !Array.isArray(res.json["entries"])) {
    return {
      error: res.error || "dnc entries missing",
      entries: /** @type {Record<string, unknown>[] | null} */ (null),
    };
  }
  const entries = res.json["entries"].filter(isRecord);
  return { error: null, entries };
}

/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function step(name, fn) {
  try {
    await fn();
    if (!seen.has(name)) record(name, "FAIL", "no result recorded");
  } catch (error) {
    if (!seen.has(name)) {
      record(name, "FAIL", error instanceof Error ? error.message : "failed");
    }
  }
}

async function proveTokenRefresh() {
  try {
    const { loadConfig } = await import("../dist/config.js");
    const { createRuntime } = await import("../dist/runtime.js");
    const { mauticObject } = await import("../dist/mautic-api.js");
    let tokenPosts = 0;
    let clock = Date.now();
    const fetchImpl = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/oauth/v2/token")) tokenPosts += 1;
      return fetch(input, init);
    };
    const runtime = createRuntime(loadConfig(process.env, []), {
      fetchImpl,
      now: () => clock,
    });
    await runtime.client.getJson(
      { path: "api/contacts/4", query: undefined, ttlSec: 0 },
      mauticObject,
    );
    const first = tokenPosts;
    clock += 48 * 60 * 60 * 1000;
    await runtime.client.getJson(
      { path: "api/contacts/4", query: undefined, ttlSec: 0 },
      mauticObject,
    );
    const second = tokenPosts;
    if (first === 1 && second === 2) {
      record("oauth_token_refresh", "PASS", "token POST count 1 then 2 after a 48h clock jump");
      return;
    }
    record("oauth_token_refresh", "FAIL", `token POST count ${first} then ${second}`);
  } catch (error) {
    record(
      "oauth_token_refresh",
      "FAIL",
      error instanceof Error ? error.message : "refresh failed",
    );
  }
}

function childEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["MAUTIC_CACHE_TTL_SEC"] = "0";
  env["MAUTIC_PER_MINUTE"] = "600";
  env["MAUTIC_TIMEOUT_MS"] = "60000";
  return env;
}

async function connectClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv(),
    stderr: "pipe",
  });
  const stderr = transport.stderr;
  if (stderr && "on" in stderr) {
    stderr.on("data", (chunk) => {
      const text = redact(String(chunk));
      if (text.includes("NO_COLOR") && text.includes("FORCE_COLOR")) return;
      if (text.trim().length === 0) return;
      console.error(`server_stderr ${clip(text)}`);
    });
  }
  client = new Client({ name: "mautic-live-smoke", version: "0" });
  await client.connect(transport);
}

/**
 * @param {Record<string, unknown>} json
 * @param {string | number} id
 */
function pageHas(json, id) {
  const items = itemsOf(json);
  if (!items) return "items missing";
  if (typeof json["total"] !== "number") return "total missing";
  if (!items.some((item) => sameId(item["id"], id))) return `id ${id} missing`;
  return null;
}

async function runReads() {
  await step("mautic_list_segments", async () => {
    await expectRead(
      "mautic_list_segments",
      { limit: 100, start: 0 },
      (json) => {
        const err = pageHas(json, seeds.segment);
        if (err) return err;
        const items = itemsOf(json) ?? [];
        const row = items.find((item) => sameId(item["id"], seeds.segment));
        const alias = row && typeof row["alias"] === "string" ? row["alias"] : "";
        if (!alias) return "segment alias missing";
        state.segmentAlias = alias;
        return null;
      },
      (json) => `total=${String(json["total"])} alias=${state.segmentAlias}`,
    );
  });

  await step("mautic_search_contacts", async () => {
    const search = `segment:${state.segmentAlias || "local-vips"}`;
    await expectRead(
      "mautic_search_contacts",
      { search, limit: 100, start: 0 },
      (json) => {
        const items = itemsOf(json);
        if (!items) return "items missing";
        const ids = new Set(items.map((item) => String(item["id"])));
        if (!ids.has(String(seeds.contacts[0])) || !ids.has(String(seeds.contacts[1]))) {
          return "seeded segment members missing";
        }
        return null;
      },
      () => `segment ${state.segmentAlias} includes seeded contacts`,
    );
  });

  await step("mautic_get_contact", async () => {
    await expectRead(
      "mautic_get_contact",
      { contact_id: String(seeds.contacts[0]) },
      (json) => {
        const contact = unwrap(json, "contact");
        if (!sameId(contact["id"], seeds.contacts[0])) return "contact id mismatch";
        if (pointsOf(contact) === null) return "points missing";
        return null;
      },
      () => `contact ${seeds.contacts[0]}`,
    );
  });

  await step("mautic_list_companies", async () => {
    await expectRead(
      "mautic_list_companies",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.company),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_get_company", async () => {
    await expectRead(
      "mautic_get_company",
      { company_id: String(seeds.company) },
      (json) => {
        const company = unwrap(json, "company");
        if (!sameId(company["id"], seeds.company)) return "company id mismatch";
        if (!textField(company, "companyname")) return "companyname missing";
        return null;
      },
      () => `company ${seeds.company}`,
    );
  });

  await step("mautic_list_emails", async () => {
    await expectRead(
      "mautic_list_emails",
      { limit: 100, start: 0 },
      (json) => {
        const template = pageHas(json, seeds.email_template);
        if (template) return template;
        return pageHas(json, seeds.email_segment);
      },
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_get_email", async () => {
    await expectRead(
      "mautic_get_email",
      { email_id: String(seeds.email_template) },
      (json) =>
        sameId(unwrap(json, "email")["id"], seeds.email_template) ? null : "email id mismatch",
      () => `email ${seeds.email_template}`,
    );
  });

  await step("mautic_get_email_stats", async () => {
    await expectRead(
      "mautic_get_email_stats",
      { email_id: String(seeds.email_template) },
      (json) => (countOf(json, "sentCount") === null ? "sentCount missing" : null),
      (json) => `sentCount=${String(countOf(json, "sentCount"))}`,
    );
  });

  await step("mautic_list_campaigns", async () => {
    await expectRead(
      "mautic_list_campaigns",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.campaign),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_get_campaign", async () => {
    await expectRead(
      "mautic_get_campaign",
      { campaign_id: String(seeds.campaign) },
      (json) =>
        sameId(unwrap(json, "campaign")["id"], seeds.campaign) ? null : "campaign id mismatch",
      () => `campaign ${seeds.campaign}`,
    );
  });

  await step("mautic_list_forms", async () => {
    await expectRead(
      "mautic_list_forms",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.form),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_get_form", async () => {
    await expectRead(
      "mautic_get_form",
      { form_id: String(seeds.form) },
      (json) => (sameId(unwrap(json, "form")["id"], seeds.form) ? null : "form id mismatch"),
      () => `form ${seeds.form}`,
    );
  });

  await step("mautic_list_form_submissions", async () => {
    await expectRead(
      "mautic_list_form_submissions",
      { form_id: String(seeds.form), limit: 30, start: 0 },
      (json) => {
        const items = itemsOf(json);
        if (!items) return "items missing";
        if (items.length < 1) return "no submissions";
        return null;
      },
      (json) => `submissions=${String((itemsOf(json) ?? []).length)}`,
    );
  });

  await step("mautic_list_stages", async () => {
    await expectRead(
      "mautic_list_stages",
      { limit: 100, start: 0 },
      (json) => {
        const first = pageHas(json, seeds.stage);
        if (first) return first;
        return pageHas(json, seeds.stage2);
      },
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_point_triggers", async () => {
    await expectRead(
      "mautic_list_point_triggers",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.point_trigger),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_point_actions", async () => {
    await expectRead(
      "mautic_list_point_actions",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.point_action),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_notes", async () => {
    await expectRead(
      "mautic_list_notes",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.note),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_reports", async () => {
    await expectRead(
      "mautic_list_reports",
      { limit: 30, start: 0 },
      (json) => {
        const items = itemsOf(json);
        if (!items || items.length < 1) return "no reports";
        if (typeof json["total"] !== "number" || json["total"] < 1) return "total missing";
        return null;
      },
      (json) => {
        const first = (itemsOf(json) ?? [])[0];
        return `total=${String(json["total"])} first=${first ? String(first["id"]) : "?"}`;
      },
    );
  });

  await step("mautic_get_report", async () => {
    const listed = await call("mautic_list_reports", { limit: 30, start: 0 });
    const first = listed.json ? (itemsOf(listed.json) ?? [])[0] : undefined;
    const reportId = first ? String(first["id"]) : "";
    if (!reportId) return record("mautic_get_report", "FAIL", "no report id");
    await expectRead(
      "mautic_get_report",
      { report_id: reportId, limit: 5, page: 1 },
      (json) => {
        if ("totalResults" in json || "data" in json || "report" in json) return null;
        return "report shape missing";
      },
      () => `report ${reportId}`,
    );
  });

  await step("mautic_list_stat_tables", async () => {
    await expectRead(
      "mautic_list_stat_tables",
      {},
      (json) => (json["availableTables"] === undefined ? "availableTables missing" : null),
      () => "availableTables present",
    );
  });

  await step("mautic_get_stats", async () => {
    await expectRead(
      "mautic_get_stats",
      { table: "email_stats", start: 0, limit: 5 },
      (json) => (itemsOf(json) ? null : "items missing"),
      (json) => `email_stats total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_assets", async () => {
    await expectRead(
      "mautic_list_assets",
      { limit: 100, start: 0 },
      (json) => pageHas(json, seeds.asset),
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_get_asset", async () => {
    await expectRead(
      "mautic_get_asset",
      { asset_id: String(seeds.asset) },
      (json) => (sameId(unwrap(json, "asset")["id"], seeds.asset) ? null : "asset id mismatch"),
      () => `asset ${seeds.asset}`,
    );
  });

  await step("mautic_list_webhook_triggers", async () => {
    await expectRead(
      "mautic_list_webhook_triggers",
      {},
      (json) => {
        if (!Array.isArray(json["triggers"])) return "triggers missing";
        const names = json["triggers"].filter(isRecord).map((row) => String(row["name"] ?? ""));
        if (names.length < 1 || names.some((name) => name.length === 0))
          return "trigger name missing";
        const sorted = [...names].sort();
        if (names.join("\n") !== sorted.join("\n")) return "triggers not sorted";
        state.triggerName = names[0] ?? "";
        return null;
      },
      (json) => `triggers=${String((json["triggers"] ?? []).length)}`,
    );
  });

  await step("mautic_list_webhooks", async () => {
    await expectRead(
      "mautic_list_webhooks",
      { limit: 30, start: 0 },
      (json) => {
        if (!itemsOf(json)) return "items missing";
        if (typeof json["total"] !== "number") return "total missing";
        return null;
      },
      (json) => `total=${String(json["total"])}`,
    );
  });

  await step("mautic_check_contact_dnc", async () => {
    await expectRead(
      "mautic_check_contact_dnc",
      { contact_id: String(seeds.contacts[0]), channel: "email" },
      (json) => {
        if (!Array.isArray(json["entries"])) return "entries missing";
        if (json["channel"] !== "email") return "channel not echoed";
        return null;
      },
      (json) => `entries=${String(json["entries"]?.length ?? 0)}`,
    );
  });

  await step("mautic_get_contact_activity", async () => {
    await expectRead(
      "mautic_get_contact_activity",
      {
        contact_id: String(seeds.contacts[0]),
        dateFrom: "2020-01-01 00:00:00",
        order: ["timestamp", "desc"],
        page: 1,
        limit: 5,
      },
      (json) => {
        if (!Array.isArray(json["events"])) return "events missing";
        if (typeof json["total"] !== "number") return "total missing";
        if (Array.isArray(json["order"]) && json["order"].length > 0) {
          const dirs = json["order"].map((part) => String(part));
          if (!dirs.includes("DESC")) return "order not DESC";
        }
        return null;
      },
      (json) => `events=${String(json["events"]?.length ?? 0)} total=${String(json["total"])}`,
    );
  });

  await step("mautic_list_activity", async () => {
    await expectRead(
      "mautic_list_activity",
      {
        dateFrom: "2020-01-01 00:00:00",
        order: ["timestamp", "DESC"],
        page: 1,
        limit: 2,
      },
      (json) => {
        if (!Array.isArray(json["events"])) return "events missing";
        if (typeof json["total"] !== "number") return "total missing";
        return null;
      },
      (json) =>
        `events=${String(json["events"]?.length ?? 0)} total=${String(json["total"])} limit=${String(json["limit"])}`,
    );
  });
}

async function runWrites() {
  const segmentId = String(seeds.segment);
  const campaignId = String(seeds.campaign);
  const stage = String(seeds.stage);

  await step("mautic_create_contact", async () => {
    const before = await contactTotal();
    await confirmWrite("mautic_create_contact", {
      args: { email, firstname: contactName },
      method: "POST",
      pathPart: "api/contacts/new",
      unchanged: async () => {
        const after = await contactTotal();
        if (before.error || after.error || before.total === null || after.total === null) {
          return before.error || after.error || "total missing";
        }
        if (before.total !== after.total) return "contact total changed";
        return null;
      },
      onConfirmed: (json) => {
        state.contactId = idOf(json, "contact");
      },
      effect: async () => {
        if (!state.contactId) return "contact id missing";
        const loaded = await loadContact(state.contactId);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (textField(loaded.contact, "firstname") !== contactName) return "firstname mismatch";
        const after = await contactTotal();
        if (after.total === null || before.total === null || after.total < before.total + 1) {
          return "contact total did not grow";
        }
        return null;
      },
      reason: "dry-run left contact total unchanged; confirm created Smoke Test",
    });
  });

  const contactId = () => state.contactId;

  await step("mautic_update_contact", async () => {
    const id = contactId();
    if (!id) return record("mautic_update_contact", "FAIL", "no contact");
    await confirmWrite("mautic_update_contact", {
      args: { contact_id: id, fields: { city } },
      method: "PATCH",
      pathPart: "/edit",
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (textField(loaded.contact, "city") === city) return "city already set";
        return null;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (textField(loaded.contact, "city") !== city) return "city not updated";
        return null;
      },
      reason: "dry-run left city unchanged; confirm set city",
    });
  });

  await step("mautic_add_contact_tags", async () => {
    const id = contactId();
    if (!id) return record("mautic_add_contact_tags", "FAIL", "no contact");
    await confirmWrite("mautic_add_contact_tags", {
      args: { contact_id: id, tags: [tag] },
      method: "PATCH",
      pathPart: "/edit",
      checkDry: (json) => {
        const body = isRecord(json["body"]) ? json["body"] : {};
        const tags = body["tags"];
        if (!Array.isArray(tags) || !tags.includes(tag)) return "tag missing from preview";
        return null;
      },
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (tagNames(loaded.contact).includes(tag)) return "tag already present";
        return null;
      },
      onConfirmed: () => {
        state.tagOn = true;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (!tagNames(loaded.contact).includes(tag)) return "tag absent";
        return null;
      },
      reason: "dry-run left tags unchanged; confirm added tag",
    });
  });

  await step("mautic_remove_contact_tags", async () => {
    const id = contactId();
    if (!id) return record("mautic_remove_contact_tags", "FAIL", "no contact");
    await confirmWrite("mautic_remove_contact_tags", {
      args: { contact_id: id, tags: [tag] },
      method: "PATCH",
      pathPart: "/edit",
      checkDry: (json) => {
        const body = isRecord(json["body"]) ? json["body"] : {};
        const tags = body["tags"];
        if (!Array.isArray(tags) || !tags.includes(`-${tag}`)) return "minus tag missing";
        return null;
      },
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (!tagNames(loaded.contact).includes(tag)) return "tag disappeared";
        return null;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (tagNames(loaded.contact).includes(tag)) return "tag still present";
        state.tagOn = false;
        return null;
      },
      reason: "dry-run left tag in place; confirm removed tag",
    });
  });

  await step("mautic_add_contact_to_segment", async () => {
    const id = contactId();
    if (!id) return record("mautic_add_contact_to_segment", "FAIL", "no contact");
    const search = `segment:${state.segmentAlias}`;
    await confirmWrite("mautic_add_contact_to_segment", {
      args: { segment_id: segmentId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/add`,
      unchanged: async () => {
        const members = await segmentMembers(search);
        if (!members.ids) return members.error || "search failed";
        if (members.ids.includes(id)) return "already in segment";
        return null;
      },
      onConfirmed: () => {
        state.inSegment = true;
      },
      effect: async (json) => {
        const members = await segmentMembers(search);
        if (!members.ids) return members.error || "search failed";
        if (!members.ids.includes(id)) return "not in segment";
        if (json["success"] !== 1 && json["success"] !== true) return "success flag missing";
        return null;
      },
      reason: "dry-run left segment membership unchanged; confirm added contact",
    });
  });

  await step("mautic_send_email_to_segment", async () => {
    const emailId = String(seeds.email_segment);
    const before = await emailSent(emailId);
    await confirmWrite("mautic_send_email_to_segment", {
      args: { email_id: emailId, listIds: [segmentId] },
      method: "POST",
      pathPart: `api/emails/${emailId}/send`,
      checkDry: (json) => {
        const body = isRecord(json["body"]) ? json["body"] : {};
        const listIds = body["listIds"];
        if (!Array.isArray(listIds) || listIds.length !== 1 || !sameId(listIds[0], segmentId)) {
          return "listIds preview mismatch";
        }
        return null;
      },
      unchanged: async () => {
        const after = await emailSent(emailId);
        if (before.count === null || after.count === null)
          return before.error || after.error || "sentCount missing";
        if (before.count !== after.count) return "sentCount changed";
        return null;
      },
      effect: async (json) => {
        const reported = json["sentCount"];
        if (typeof reported !== "number" || reported < 1) {
          return `response sentCount=${String(reported)}`;
        }
        const after = await emailSent(emailId);
        if (before.count === null || after.count === null)
          return after.error || "sentCount missing";
        if (after.count < before.count + reported) return "email sentCount did not increase";
        if (json["success"] !== 1 && json["success"] !== true) return "success flag missing";
        return null;
      },
      reason: "dry-run left sentCount unchanged; confirm sent to the new segment member",
    });
  });

  await step("mautic_remove_contact_from_segment", async () => {
    const id = contactId();
    if (!id) return record("mautic_remove_contact_from_segment", "FAIL", "no contact");
    const search = `segment:${state.segmentAlias}`;
    await confirmWrite("mautic_remove_contact_from_segment", {
      args: { segment_id: segmentId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/remove`,
      unchanged: async () => {
        const members = await segmentMembers(search);
        if (!members.ids) return members.error || "search failed";
        if (!members.ids.includes(id)) return "membership disappeared";
        return null;
      },
      effect: async () => {
        const members = await segmentMembers(search);
        if (!members.ids) return members.error || "search failed";
        if (members.ids.includes(id)) return "still in segment";
        state.inSegment = false;
        return null;
      },
      reason: "dry-run left membership; confirm removed contact",
    });
  });

  await step("mautic_create_company", async () => {
    const before = await companyTotal();
    await confirmWrite("mautic_create_company", {
      args: { companyname: companyName },
      method: "POST",
      pathPart: "api/companies/new",
      unchanged: async () => {
        const after = await companyTotal();
        if (before.total === null || after.total === null)
          return before.error || after.error || "total missing";
        if (before.total !== after.total) return "company total changed";
        return null;
      },
      onConfirmed: (json) => {
        state.companyId = idOf(json, "company");
      },
      effect: async () => {
        if (!state.companyId) return "company id missing";
        const loaded = await loadCompany(state.companyId);
        if (!loaded.company) return loaded.error || "company missing";
        if (textField(loaded.company, "companyname") !== companyName) return "companyname mismatch";
        return null;
      },
      reason: "dry-run left company total unchanged; confirm created company",
    });
  });

  await step("mautic_update_company", async () => {
    const id = state.companyId;
    if (!id) return record("mautic_update_company", "FAIL", "no company");
    await confirmWrite("mautic_update_company", {
      args: { company_id: id, companycity: city },
      method: "PATCH",
      pathPart: "/edit",
      unchanged: async () => {
        const loaded = await loadCompany(id);
        if (!loaded.company) return loaded.error || "company missing";
        if (textField(loaded.company, "companycity") === city) return "city already set";
        return null;
      },
      effect: async () => {
        const loaded = await loadCompany(id);
        if (!loaded.company) return loaded.error || "company missing";
        if (textField(loaded.company, "companycity") !== city) return "city not updated";
        return null;
      },
      reason: "dry-run left company city unchanged; confirm set city",
    });
  });

  await step("mautic_add_contact_to_company", async () => {
    const id = contactId();
    const companyId = state.companyId;
    if (!id || !companyId)
      return record("mautic_add_contact_to_company", "FAIL", "no contact or company");
    const where = [
      { col: "lead_id", expr: "eq", val: id },
      { col: "company_id", expr: "eq", val: companyId },
    ];
    await confirmWrite("mautic_add_contact_to_company", {
      args: { company_id: companyId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/add`,
      unchanged: async () => {
        const rows = await statsRows("companies_leads", where);
        if (!rows.items) return rows.error || "stats failed";
        if (rows.items.length > 0) return "link already present";
        return null;
      },
      onConfirmed: () => {
        state.inCompany = true;
      },
      effect: async () => {
        const rows = await statsRows("companies_leads", where);
        if (!rows.items) return rows.error || "stats failed";
        if (rows.items.length < 1) return "link missing";
        return null;
      },
      reason: "dry-run left company link absent; confirm added link",
    });
  });

  await step("mautic_remove_contact_from_company", async () => {
    const id = contactId();
    const companyId = state.companyId;
    if (!id || !companyId) {
      return record("mautic_remove_contact_from_company", "FAIL", "no contact or company");
    }
    const where = [
      { col: "lead_id", expr: "eq", val: id },
      { col: "company_id", expr: "eq", val: companyId },
    ];
    await confirmWrite("mautic_remove_contact_from_company", {
      args: { company_id: companyId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/remove`,
      unchanged: async () => {
        const rows = await statsRows("companies_leads", where);
        if (!rows.items) return rows.error || "stats failed";
        if (rows.items.length < 1) return "link disappeared";
        return null;
      },
      effect: async () => {
        const rows = await statsRows("companies_leads", where);
        if (!rows.items) return rows.error || "stats failed";
        if (rows.items.length > 0) return "link still present";
        state.inCompany = false;
        return null;
      },
      reason: "dry-run left company link; confirm removed link",
    });
  });

  await step("mautic_send_email_to_contact", async () => {
    const id = contactId();
    if (!id) return record("mautic_send_email_to_contact", "FAIL", "no contact");
    const emailId = String(seeds.email_template);
    const before = await emailSent(emailId);
    await confirmWrite("mautic_send_email_to_contact", {
      args: { email_id: emailId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/send`,
      unchanged: async () => {
        const after = await emailSent(emailId);
        if (before.count === null || after.count === null)
          return before.error || after.error || "sentCount missing";
        if (before.count !== after.count) return "sentCount changed";
        return null;
      },
      effect: async (json) => {
        const after = await emailSent(emailId);
        if (before.count === null || after.count === null)
          return after.error || "sentCount missing";
        if (after.count < before.count + 1) return "sentCount did not increase";
        if (json["success"] !== true && json["success"] !== 1) return "success flag missing";
        return null;
      },
      reason: "dry-run left sentCount unchanged; confirm sent template email",
    });
  });

  await step("mautic_add_contact_to_campaign", async () => {
    const id = contactId();
    if (!id) return record("mautic_add_contact_to_campaign", "FAIL", "no contact");
    const where = [
      { col: "lead_id", expr: "eq", val: id },
      { col: "campaign_id", expr: "eq", val: campaignId },
    ];
    await confirmWrite("mautic_add_contact_to_campaign", {
      args: { campaign_id: campaignId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/add`,
      unchanged: async () => {
        const rows = await statsRows("campaign_leads", where);
        if (!rows.items) return rows.error || "stats failed";
        if (rows.items.length > 0) return "campaign row already present";
        return null;
      },
      onConfirmed: () => {
        state.inCampaign = true;
      },
      effect: async () => {
        const rows = await statsRows("campaign_leads", where);
        if (!rows.items || rows.items.length < 1) return rows.error || "campaign row missing";
        return null;
      },
      reason: "dry-run left campaign row absent; confirm added contact",
    });
  });

  await step("mautic_remove_contact_from_campaign", async () => {
    const id = contactId();
    if (!id) return record("mautic_remove_contact_from_campaign", "FAIL", "no contact");
    const where = [
      { col: "lead_id", expr: "eq", val: id },
      { col: "campaign_id", expr: "eq", val: campaignId },
    ];
    await confirmWrite("mautic_remove_contact_from_campaign", {
      args: { campaign_id: campaignId, contact_id: id },
      method: "POST",
      pathPart: `/contact/${id}/remove`,
      unchanged: async () => {
        const rows = await statsRows("campaign_leads", where);
        if (!rows.items || rows.items.length < 1) return rows.error || "campaign row missing";
        const removed = rows.items[0]?.["manually_removed"];
        if (String(removed) === "1") return "already manually removed";
        return null;
      },
      effect: async () => {
        const rows = await statsRows("campaign_leads", where);
        if (!rows.items || rows.items.length < 1) return rows.error || "campaign row deleted";
        if (String(rows.items[0]?.["manually_removed"]) !== "1") return "manually_removed is not 1";
        state.inCampaign = false;
        return null;
      },
      reason: "dry-run left campaign row; confirm set manually_removed",
    });
  });

  await step("mautic_change_contact_stage", async () => {
    const id = contactId();
    if (!id) return record("mautic_change_contact_stage", "FAIL", "no contact");
    const before = await loadContact(id);
    const beforeStage = before.contact ? stageId(before.contact) : null;
    await confirmWrite("mautic_change_contact_stage", {
      args: { stage_id: stage, contact_id: id },
      method: "POST",
      pathPart: `api/stages/${stage}/contact/${id}/add`,
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (stageId(loaded.contact) !== beforeStage) return "stage changed";
        return null;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (stageId(loaded.contact) !== stage) return "stage not updated";
        return null;
      },
      reason: "dry-run left stage unchanged; confirm moved stage",
    });
  });

  await step("mautic_adjust_contact_points", async () => {
    const id = contactId();
    if (!id) return record("mautic_adjust_contact_points", "FAIL", "no contact");
    const start = await loadContact(id);
    if (!start.contact)
      return record("mautic_adjust_contact_points", "FAIL", start.error || "contact missing");
    const startPoints = pointsOf(start.contact);
    if (startPoints === null)
      return record("mautic_adjust_contact_points", "FAIL", "points missing");

    const plus = await call("mautic_adjust_contact_points", {
      contact_id: id,
      operation: "plus",
      points: 4,
      eventName: "Smoke points",
      actionName: "Smoke action",
    });
    const plusDry = dryError(plus, "POST", `/points/plus/4`);
    if (plusDry) return record("mautic_adjust_contact_points", "FAIL", `plus dry-run: ${plusDry}`);
    const plusBody = plus.json && isRecord(plus.json["body"]) ? plus.json["body"] : {};
    if (plusBody["eventName"] !== "Smoke points" || plusBody["actionName"] !== "Smoke action") {
      return record("mautic_adjust_contact_points", "FAIL", "plus preview names mismatch");
    }
    const afterPlusDry = await loadContact(id);
    if (!afterPlusDry.contact || pointsOf(afterPlusDry.contact) !== startPoints) {
      return record("mautic_adjust_contact_points", "FAIL", "plus dry-run changed points");
    }
    const plusLive = await call("mautic_adjust_contact_points", {
      contact_id: id,
      operation: "plus",
      points: 4,
      eventName: "Smoke points",
      actionName: "Smoke action",
      confirm: true,
    });
    if (!plusLive.ok || !plusLive.json) {
      return record("mautic_adjust_contact_points", "FAIL", `plus confirm: ${plusLive.error}`);
    }
    const plusFlag = successError(plusLive.json);
    if (plusFlag) return record("mautic_adjust_contact_points", "FAIL", plusFlag);
    const afterPlus = await loadContact(id);
    if (!afterPlus.contact || pointsOf(afterPlus.contact) !== startPoints + 4) {
      return record("mautic_adjust_contact_points", "FAIL", "plus did not add 4");
    }

    const minus = await call("mautic_adjust_contact_points", {
      contact_id: id,
      operation: "minus",
      points: 1,
      eventName: "Smoke minus",
      actionName: "Smoke subtract",
    });
    const minusDry = dryError(minus, "POST", "/points/minus/1");
    if (minusDry)
      return record("mautic_adjust_contact_points", "FAIL", `minus dry-run: ${minusDry}`);
    const minusBody = minus.json && isRecord(minus.json["body"]) ? minus.json["body"] : {};
    if (minusBody["eventName"] !== "Smoke minus" || minusBody["actionName"] !== "Smoke subtract") {
      return record("mautic_adjust_contact_points", "FAIL", "minus preview names mismatch");
    }
    const afterMinusDry = await loadContact(id);
    if (!afterMinusDry.contact || pointsOf(afterMinusDry.contact) !== startPoints + 4) {
      return record("mautic_adjust_contact_points", "FAIL", "minus dry-run changed points");
    }
    const minusLive = await call("mautic_adjust_contact_points", {
      contact_id: id,
      operation: "minus",
      points: 1,
      eventName: "Smoke minus",
      actionName: "Smoke subtract",
      confirm: true,
    });
    if (!minusLive.ok || !minusLive.json) {
      return record("mautic_adjust_contact_points", "FAIL", `minus confirm: ${minusLive.error}`);
    }
    const afterMinus = await loadContact(id);
    if (!afterMinus.contact || pointsOf(afterMinus.contact) !== startPoints + 3) {
      return record("mautic_adjust_contact_points", "FAIL", "minus did not subtract 1");
    }
    const log = await statsRows("lead_points_change_log", [
      { col: "lead_id", expr: "eq", val: id },
    ]);
    if (!log.items)
      return record("mautic_adjust_contact_points", "FAIL", log.error || "point log missing");
    const names = log.items.map((row) => String(row["event_name"] ?? row["eventName"] ?? ""));
    if (!names.includes("Smoke points") || !names.includes("Smoke minus")) {
      const columns = log.items[0] ? Object.keys(log.items[0]).slice(0, 12).join(",") : "none";
      return record(
        "mautic_adjust_contact_points",
        "FAIL",
        `point log missing event names (${columns})`,
      );
    }
    record(
      "mautic_adjust_contact_points",
      "PASS",
      "dry-runs left points unchanged; plus 4 then minus 1; log has both event names",
    );
  });

  await step("mautic_create_note", async () => {
    const id = contactId();
    if (!id) return record("mautic_create_note", "FAIL", "no contact");
    await confirmWrite("mautic_create_note", {
      args: { lead: id, text: noteText, type: "general" },
      method: "POST",
      pathPart: "api/notes/new",
      unchanged: async () => {
        const notes = await notePresent(id);
        if (notes.error) return notes.error;
        if (notes.present) return "note already present";
        return null;
      },
      effect: async () => {
        const notes = await notePresent(id);
        if (notes.error) return notes.error;
        if (!notes.present) return "note absent";
        return null;
      },
      reason: "dry-run left notes unchanged; confirm created note",
    });
  });

  await step("mautic_add_contact_dnc", async () => {
    const id = contactId();
    if (!id) return record("mautic_add_contact_dnc", "FAIL", "no contact");
    await confirmWrite("mautic_add_contact_dnc", {
      args: {
        contact_id: id,
        channel: "email",
        reason: 3,
        channelId: String(seeds.email_template),
        comments: "smoke dnc",
      },
      method: "POST",
      pathPart: "/dnc/email/add",
      checkDry: (json) => {
        const body = isRecord(json["body"]) ? json["body"] : {};
        if (body["reason"] !== 3 || body["comments"] !== "smoke dnc") return "dnc preview mismatch";
        return null;
      },
      unchanged: async () => {
        const rows = await emailDnc(id);
        if (!rows.entries) return rows.error || "dnc read failed";
        if (rows.entries.some((entry) => entry["channel"] === "email")) return "dnc already set";
        return null;
      },
      onConfirmed: () => {
        state.dncOn = true;
      },
      effect: async () => {
        const rows = await emailDnc(id);
        if (!rows.entries) return rows.error || "dnc read failed";
        const hit = rows.entries.find((entry) => entry["channel"] === "email");
        if (!hit) return "email dnc absent";
        if (String(hit["reason"]) !== "3") return "dnc reason mismatch";
        return null;
      },
      reason: "dry-run left email DNC unset; confirm added manual DNC",
    });
  });

  await step("mautic_remove_contact_dnc", async () => {
    const id = contactId();
    if (!id) return record("mautic_remove_contact_dnc", "FAIL", "no contact");
    await confirmWrite("mautic_remove_contact_dnc", {
      args: { contact_id: id, channel: "email" },
      method: "POST",
      pathPart: "/dnc/email/remove",
      unchanged: async () => {
        const rows = await emailDnc(id);
        if (!rows.entries) return rows.error || "dnc read failed";
        if (!rows.entries.some((entry) => entry["channel"] === "email")) return "dnc disappeared";
        return null;
      },
      effect: async () => {
        const rows = await emailDnc(id);
        if (!rows.entries) return rows.error || "dnc read failed";
        if (rows.entries.some((entry) => entry["channel"] === "email"))
          return "email dnc still set";
        state.dncOn = false;
        return null;
      },
      reason: "dry-run left email DNC; confirm cleared it",
    });
  });

  await step("mautic_create_webhook", async () => {
    if (!state.triggerName) return record("mautic_create_webhook", "FAIL", "no trigger name");
    const before = await webhookTotal();
    await confirmWrite("mautic_create_webhook", {
      args: {
        name: hookName,
        webhookUrl: hookUrl,
        triggers: [state.triggerName],
        description: "smoke",
        eventsOrderbyDir: "desc",
        isPublished: false,
      },
      method: "POST",
      pathPart: "api/hooks/new",
      checkDry: (json) => {
        const body = isRecord(json["body"]) ? json["body"] : {};
        if (body["eventsOrderbyDir"] !== "DESC") return "eventsOrderbyDir not DESC";
        if (body["isPublished"] !== false) return "isPublished preview mismatch";
        if (body["webhookUrl"] !== hookUrl) return "webhookUrl preview mismatch";
        return null;
      },
      unchanged: async () => {
        const after = await webhookTotal();
        if (before.total === null || after.total === null)
          return before.error || after.error || "total missing";
        if (before.total !== after.total) return "webhook total changed";
        return null;
      },
      onConfirmed: (json) => {
        state.webhookId = idOf(json, "hook");
      },
      effect: async () => {
        if (!state.webhookId) return "webhook id missing";
        const after = await webhookTotal();
        if (before.total === null || after.total === null || after.total < before.total + 1) {
          return "webhook total did not grow";
        }
        return null;
      },
      reason: "dry-run left webhook total unchanged; confirm created webhook",
    });
  });

  await step("mautic_get_webhook", async () => {
    if (!state.webhookId) return record("mautic_get_webhook", "FAIL", "no webhook id");
    await expectRead(
      "mautic_get_webhook",
      { webhook_id: state.webhookId },
      (json) => {
        const hook = unwrap(json, "hook");
        if (!sameId(hook["id"], state.webhookId)) return "webhook id mismatch";
        if (hook["name"] !== hookName) return "webhook name mismatch";
        return null;
      },
      () => `webhook ${state.webhookId} secret stripped`,
    );
  });

  await step("mautic_delete_webhook", async () => {
    const id = state.webhookId;
    if (!id) return record("mautic_delete_webhook", "FAIL", "no webhook id");
    const before = await webhookTotal();
    await confirmWrite("mautic_delete_webhook", {
      args: { webhook_id: id },
      method: "DELETE",
      pathPart: `/hooks/${id}/delete`,
      unchanged: async () => {
        const after = await webhookTotal();
        if (before.total === null || after.total === null)
          return before.error || after.error || "total missing";
        if (before.total !== after.total) return "webhook total changed";
        return null;
      },
      effect: async () => {
        const after = await webhookTotal();
        if (before.total === null || after.total === null) return after.error || "total missing";
        if (after.total !== before.total - 1) return "webhook total did not drop";
        state.webhookId = undefined;
        return null;
      },
      reason: "dry-run left webhook; confirm deleted it",
    });
  });
}

async function runOauthSubset() {
  const id = String(seeds.contacts[2]);
  await step("mautic_get_contact", async () => {
    await expectRead(
      "mautic_get_contact",
      { contact_id: id },
      (json) => (sameId(unwrap(json, "contact")["id"], id) ? null : "contact id mismatch"),
      () => `contact ${id}`,
    );
  });
  await step("mautic_list_segments", async () => {
    await expectRead(
      "mautic_list_segments",
      { limit: 30, start: 0 },
      (json) => {
        const err = pageHas(json, seeds.segment);
        if (err) return err;
        const row = (itemsOf(json) ?? []).find((item) => sameId(item["id"], seeds.segment));
        state.segmentAlias = row && typeof row["alias"] === "string" ? row["alias"] : "";
        if (!state.segmentAlias) return "segment alias missing";
        return null;
      },
      () => `segment ${seeds.segment} alias=${state.segmentAlias}`,
    );
  });
  await step("mautic_search_contacts", async () => {
    await expectRead(
      "mautic_search_contacts",
      { search: `segment:${state.segmentAlias}`, limit: 30, start: 0 },
      (json) => {
        const items = itemsOf(json);
        if (!items) return "items missing";
        if (!items.some((item) => sameId(item["id"], seeds.contacts[0])))
          return "seed contact missing";
        return null;
      },
      () => `segment ${state.segmentAlias}`,
    );
  });
  await step("mautic_add_contact_tags", async () => {
    await confirmWrite("mautic_add_contact_tags", {
      args: { contact_id: id, tags: [oauthTag] },
      method: "PATCH",
      pathPart: "/edit",
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (tagNames(loaded.contact).includes(oauthTag)) return "tag already present";
        return null;
      },
      onConfirmed: () => {
        state.oauthTagOn = true;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (!tagNames(loaded.contact).includes(oauthTag)) return "tag absent";
        return null;
      },
      reason: "dry-run left tags unchanged; confirm added oauth tag",
    });
  });
  await step("mautic_remove_contact_tags", async () => {
    await confirmWrite("mautic_remove_contact_tags", {
      args: { contact_id: id, tags: [oauthTag] },
      method: "PATCH",
      pathPart: "/edit",
      unchanged: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (!tagNames(loaded.contact).includes(oauthTag)) return "tag disappeared";
        return null;
      },
      effect: async () => {
        const loaded = await loadContact(id);
        if (!loaded.contact) return loaded.error || "contact missing";
        if (tagNames(loaded.contact).includes(oauthTag)) return "tag still present";
        state.oauthTagOn = false;
        return null;
      },
      reason: "dry-run left oauth tag; confirm removed it",
    });
  });
}

async function cleanup() {
  const id = state.contactId;
  /** @type {Array<[string, () => Promise<{ ok: boolean; error: string }>]>} */
  const jobs = [];
  if (state.webhookId) {
    const webhookId = state.webhookId;
    jobs.push([
      "cleanup_webhook",
      async () => call("mautic_delete_webhook", { webhook_id: webhookId, confirm: true }),
    ]);
  }
  if (id && state.dncOn) {
    jobs.push([
      "cleanup_dnc",
      async () =>
        call("mautic_remove_contact_dnc", { contact_id: id, channel: "email", confirm: true }),
    ]);
  }
  if (id && state.inCampaign) {
    jobs.push([
      "cleanup_campaign",
      async () =>
        call("mautic_remove_contact_from_campaign", {
          campaign_id: String(seeds.campaign),
          contact_id: id,
          confirm: true,
        }),
    ]);
  }
  if (id && state.companyId && state.inCompany) {
    const companyId = state.companyId;
    jobs.push([
      "cleanup_company",
      async () =>
        call("mautic_remove_contact_from_company", {
          company_id: companyId,
          contact_id: id,
          confirm: true,
        }),
    ]);
  }
  if (id && state.inSegment) {
    jobs.push([
      "cleanup_segment",
      async () =>
        call("mautic_remove_contact_from_segment", {
          segment_id: String(seeds.segment),
          contact_id: id,
          confirm: true,
        }),
    ]);
  }
  if (id && state.tagOn) {
    jobs.push([
      "cleanup_tag",
      async () =>
        call("mautic_remove_contact_tags", { contact_id: id, tags: [tag], confirm: true }),
    ]);
  }
  if (state.oauthTagOn) {
    jobs.push([
      "cleanup_oauth_tag",
      async () =>
        call("mautic_remove_contact_tags", {
          contact_id: String(seeds.contacts[2]),
          tags: [oauthTag],
          confirm: true,
        }),
    ]);
  }
  for (const [name, job] of jobs) {
    try {
      const res = await job();
      if (!res.ok) record(name, "FAIL", res.error);
      else record(name, "PASS", "removed leftover");
    } catch (error) {
      record(name, "FAIL", error instanceof Error ? error.message : "cleanup failed");
    }
  }
}

async function main() {
  if (mode === "oauth") await proveTokenRefresh();
  await connectClient();
  try {
    if (!client) throw new Error("client missing");
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    record("tools_list", names.length === 50 ? "PASS" : "FAIL", `count=${names.length}`);
    if (mode === "basic") {
      await runReads();
      await runWrites();
      for (const name of names) {
        if (!seen.has(name)) record(name, "FAIL", "not called");
      }
    } else {
      await runOauthSubset();
    }
  } finally {
    try {
      await cleanup();
    } catch (error) {
      record("cleanup", "FAIL", error instanceof Error ? error.message : "cleanup failed");
    }
    if (client) await client.close();
  }
  console.log(`smoke_summary ${failed ? "FAIL" : "PASS"} mode=${mode}`);
  process.exit(failed ? 1 : 0);
}

await main();
