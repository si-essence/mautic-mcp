import { z } from "zod";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export const mauticObject = z.record(z.string(), z.unknown());

export interface PageResult {
  readonly total: number;
  readonly start: number;
  readonly limit: number;
  readonly items: unknown[];
  readonly nextStart: number | null;
}

export function apiPath(...segments: readonly string[]): string {
  if (segments.length === 0) {
    throw new ConnectorError("input", "Request path must be a relative path.");
  }
  const encoded: string[] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    encoded.push(encodeURIComponent(trimmed));
  }
  return encoded.join("/");
}

export function clampLimit(limit: number, maxLimit: number): number {
  return Math.min(limit, maxLimit);
}

export function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [];
}

export function parseTotal(value: unknown, itemCount: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  return itemCount;
}

export function toPage(
  raw: unknown,
  collectionKey: string,
  start: number,
  limit: number,
): PageResult {
  const record = mauticObject.safeParse(raw);
  const obj = record.success ? record.data : {};
  const items = toArray(obj[collectionKey]);
  const total = parseTotal(obj["total"], items.length);
  const consumed = start + items.length;
  const nextStart = items.length > 0 && consumed < total ? consumed : null;
  return { total, start, limit, items, nextStart };
}

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function definedBody(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function asToolResult(parsed: unknown): Record<string, unknown> {
  const record = mauticObject.safeParse(parsed);
  if (record.success) return record.data;
  return { data: parsed };
}

export function nestedQuery(
  prefix: string,
  rows: readonly Readonly<Record<string, QueryPrimitive | undefined>>[],
): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {};
  rows.forEach((row, index) => {
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (value === undefined) continue;
      out[`${prefix}[${index}][${key}]`] = value;
    }
  });
  return out;
}

export type QueryPrimitive = string | number | boolean;

function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function toActivity(raw: unknown): Record<string, unknown> {
  const parsed = mauticObject.safeParse(raw);
  const obj = parsed.success ? parsed.data : {};
  const events = toArray(obj["events"]);
  return {
    total: parseTotal(obj["total"], events.length),
    page: parseCount(obj["page"]),
    limit: parseCount(obj["limit"]),
    maxPages: parseCount(obj["maxPages"]),
    events,
    filters: obj["filters"] ?? {},
    order: toArray(obj["order"]),
    types: obj["types"] ?? {},
  };
}

export function contactDncEntries(raw: unknown, channel: string | undefined): unknown[] {
  const parsed = mauticObject.safeParse(raw);
  const obj = parsed.success ? parsed.data : {};
  const nested = mauticObject.safeParse(obj["contact"]);
  const contact = nested.success ? nested.data : obj;
  return toArray(contact["doNotContact"]).filter((entry) => {
    if (channel === undefined) return true;
    const row = mauticObject.safeParse(entry);
    return row.success && row.data["channel"] === channel;
  });
}

export function omitWebhookSecret(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => omitWebhookSecret(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "secret") continue;
      out[key] = omitWebhookSecret(child);
    }
    return out;
  }
  return value;
}

export const webhookPayload = z.unknown().transform((value): Record<string, unknown> => {
  const parsed = mauticObject.safeParse(omitWebhookSecret(value));
  return parsed.success ? parsed.data : {};
});

export interface WebhookTrigger {
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
}

export function webhookTriggers(raw: unknown): WebhookTrigger[] {
  const parsed = mauticObject.safeParse(raw);
  const obj = parsed.success ? parsed.data : {};
  const nested = mauticObject.safeParse(obj["triggers"]);
  const map = nested.success ? nested.data : {};
  return Object.keys(map)
    .sort()
    .map((name) => {
      const row = mauticObject.safeParse(map[name]);
      const item = row.success ? row.data : {};
      const label = item["label"];
      const description = item["description"];
      return {
        name,
        label: typeof label === "string" ? label : "",
        description: typeof description === "string" ? description : null,
      };
    });
}
