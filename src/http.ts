import type { ZodType } from "zod";
import { z } from "zod";
import type { BaseUrl } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactUnknown, stripUrls } from "./redact.js";

const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface AuthProvider {
  header(): Promise<string>;
  onUnauthorized(): Promise<"retry" | "give_up">;
}

export interface JsonGet {
  path: string;
  query: QueryMap | undefined;
  ttlSec: number;
}

export interface JsonWrite {
  path: string;
  query: QueryMap | undefined;
  body: unknown;
  ttlSec: number;
  invalidate: boolean;
}

export interface FormWrite {
  path: string;
  query: QueryMap | undefined;
  fields: Readonly<Record<string, string>>;
  ttlSec: number;
  invalidate: boolean;
  skipAuth: boolean;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: readonly string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  auth: AuthProvider;
  label: string;
}

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export function serializeForm(fields: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value === undefined) continue;
    params.set(key, value);
  }
  return params.toString();
}

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: readonly string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly auth: AuthProvider;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.auth = options.auth;
    this.label = options.label;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "GET",
        path: request.path,
        query: request.query,
        bodyText: undefined,
        contentType: undefined,
        ttlSec: request.ttlSec,
        invalidate: false,
        skipAuth: false,
      },
      schema,
    );
  }

  async postJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "POST",
        path: request.path,
        query: request.query,
        bodyText: this.serializeJsonBody(request.body),
        contentType: request.body === undefined ? undefined : "application/json",
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
        skipAuth: false,
      },
      schema,
    );
  }

  async patchJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "PATCH",
        path: request.path,
        query: request.query,
        bodyText: this.serializeJsonBody(request.body),
        contentType: request.body === undefined ? undefined : "application/json",
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
        skipAuth: false,
      },
      schema,
    );
  }

  async deleteJson<T>(
    request: { path: string; query: QueryMap | undefined; ttlSec: number; invalidate: boolean },
    schema: ZodType<T>,
  ): Promise<T> {
    return this.exchange(
      {
        method: "DELETE",
        path: request.path,
        query: request.query,
        bodyText: undefined,
        contentType: undefined,
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
        skipAuth: false,
      },
      schema,
    );
  }

  async postForm<T>(request: FormWrite, schema: ZodType<T>): Promise<T> {
    return this.exchange(
      {
        method: "POST",
        path: request.path,
        query: request.query,
        bodyText: serializeForm(request.fields),
        contentType: "application/x-www-form-urlencoded",
        ttlSec: request.ttlSec,
        invalidate: request.invalidate,
        skipAuth: request.skipAuth,
      },
      schema,
    );
  }

  private async exchange<T>(
    request: {
      method: HttpMethod;
      path: string;
      query: QueryMap | undefined;
      bodyText: string | undefined;
      contentType: string | undefined;
      ttlSec: number;
      invalidate: boolean;
      skipAuth: boolean;
    },
    schema: ZodType<T>,
  ): Promise<T> {
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `${request.method} ${url.origin}${url.pathname}${url.search} ${request.bodyText ?? ""}`;
    if (request.ttlSec > 0 && !request.invalidate) {
      const cached = this.readCache(cacheKey, schema);
      if (cached !== undefined) return cached;
    }

    let retried = false;
    for (;;) {
      this.limiter.acquire();
      const response = await this.send(url, request);
      const text = await readLimited(response, this.label);
      if (response.status === 401 && !retried && !request.skipAuth) {
        const decision = await this.auth.onUnauthorized();
        if (decision === "retry") {
          retried = true;
          continue;
        }
      }
      if (!response.ok) {
        throw this.httpError(response, text);
      }
      if (/<!doctype html|<html[\s>]/i.test(text)) {
        throw new ConnectorError(
          "upstream",
          `${this.label} HTTP ${response.status}: the service returned an error page instead of JSON.`,
        );
      }
      const json = parseJsonBody(text, response.status, this.label);
      const accepted = this.accept(cacheKey, request.ttlSec, schema, json);
      if (request.invalidate) this.cache.clear();
      return accepted;
    }
  }

  private serializeJsonBody(body: unknown): string | undefined {
    if (body === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new ConnectorError("input", "Request body could not be serialized as JSON.");
    }
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    this.assertNoSecret(text);
    return text;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  private accept<T>(cacheKey: string, ttlSec: number, schema: ZodType<T>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.label} response did not match the expected shape.`,
      );
    }
    const safe = schema.safeParse(redactUnknown(parsed.data, this.secrets));
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path);
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    this.assertNoSecret(`${url.pathname}${url.search}`);
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text);
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text);
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error("Refusing to place a secret in the request URL.");
        throw new ConnectorError("config", "Refusing to place a secret in the request URL.");
      }
    }
  }

  private async send(
    url: URL,
    request: {
      method: HttpMethod;
      bodyText: string | undefined;
      contentType: string | undefined;
      skipAuth: boolean;
    },
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("user-agent", this.userAgent);
    if (!request.skipAuth) {
      headers.set("authorization", await this.auth.header());
    }
    if (request.contentType !== undefined) headers.set("content-type", request.contentType);
    try {
      const init: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (request.bodyText !== undefined) init.body = request.bodyText;
      return await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("upstream", `${this.label} request failed: ${safe}`);
    }
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicSnippet(text, this.secrets);
    const fromBody = mauticErrorMessage(text);
    const detailText =
      fromBody === undefined ? snippet : publicSnippet(fromBody, this.secrets);
    const detail = detailText.length > 0 ? `: ${detailText}` : "";
    if (response.status === 400) {
      return new ConnectorError("input", `${this.label} HTTP 400${detail}`);
    }
    if (response.status === 401) {
      return new ConnectorError("auth", `${this.label} HTTP 401${detail}`);
    }
    if (response.status === 403) {
      return new ConnectorError("upstream", `${this.label} HTTP 403 permission denied${detail}`);
    }
    if (response.status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (response.status === 429) {
      return new ConnectorError(
        "rate_limit",
        `${this.label} HTTP 429${detail}`,
        retryAfterSeconds(response),
      );
    }
    this.logger.error(`${this.label} HTTP ${response.status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${response.status}${detail}`);
  }
}

export function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

const mauticErrorList = z.object({
  errors: z
    .array(
      z.object({
        message: z.string(),
        code: z.union([z.number(), z.string(), z.null()]).optional(),
        type: z.union([z.string(), z.number(), z.null()]).optional(),
        details: z.unknown().optional(),
      }),
    )
    .min(1),
});

function detailText(details: unknown): string | undefined {
  if (Array.isArray(details)) {
    const parts = details.filter((item): item is string => typeof item === "string" && item.length > 0);
    return parts.length === 0 ? undefined : parts.join("; ");
  }
  if (details === null || typeof details !== "object") return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string" && value.length > 0) {
      parts.push(`${key}: ${value}`);
      continue;
    }
    if (!Array.isArray(value)) continue;
    const texts = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (texts.length > 0) parts.push(`${key}: ${texts.join(", ")}`);
  }
  return parts.length === 0 ? undefined : parts.join("; ");
}

function withDetails(message: string, details: unknown): string {
  const extra = detailText(details);
  if (extra === undefined || message.includes(extra)) return message;
  return `${message} (${extra})`;
}

export function mauticErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  const oauth = z
    .object({
      error: z.string(),
      error_description: z.string().optional(),
    })
    .safeParse(json);
  if (oauth.success) {
    const description = oauth.data.error_description;
    if (description !== undefined && description.trim().length > 0) return description.trim();
    return oauth.data.error;
  }
  const nested = z
    .object({
      error: z.object({
        message: z.string(),
        code: z.union([z.number(), z.string()]).optional(),
      }),
    })
    .safeParse(json);
  if (nested.success) return nested.data.error.message;
  const list = mauticErrorList.safeParse(json);
  if (list.success) {
    const first = list.data.errors[0];
    if (first !== undefined) return withDetails(first.message, first.details);
  }
  return undefined;
}

function parseJsonBody(text: string, status: number, label: string): unknown {
  if (text.trim().length === 0) {
    if (status >= 200 && status < 300) return {};
    throw new ConnectorError("upstream", `${label} returned an empty body (HTTP ${status}).`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("upstream", `${label} returned non-JSON (HTTP ${status}).`);
  }
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
