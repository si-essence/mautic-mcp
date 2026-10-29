import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import {
  CONNECTOR_NAME,
  CONNECTOR_VERSION,
  DEFAULT_CACHE_TTL_SEC,
  DEFAULT_HTTP_HOST,
  DEFAULT_MAX_LIMIT,
  DEFAULT_PER_MINUTE,
  DEFAULT_TIMEOUT_MS,
  HARD_MAX_LIMIT,
  MIN_HTTP_AUTH_TOKEN_LENGTH,
} from "./constants.js";
import { ConnectorError } from "./errors.js";
import { isLoopbackHost } from "./loopback.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  MAUTIC_BASE_URL: z.string({ error: invalid }).trim().min(1, { error: invalid }).optional(),
  MAUTIC_AUTH_MODE: z.enum(["basic", "oauth2"], { error: invalid }).optional(),
  MAUTIC_USERNAME: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MAUTIC_PASSWORD: z
    .string({ error: invalid })
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  MAUTIC_CLIENT_ID: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  MAUTIC_CLIENT_SECRET: z
    .string({ error: invalid })
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  MAUTIC_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MAUTIC_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MAUTIC_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MAUTIC_MAX_LIMIT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MAUTIC_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  MCP_HTTP_HOST: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(253, { error: invalid })
    .optional(),
  MCP_HTTP_AUTH_TOKEN: z
    .string({ error: invalid })
    .min(MIN_HTTP_AUTH_TOKEN_LENGTH, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
});

export type AuthConfig =
  | {
      readonly kind: "basic";
      readonly username: string;
      readonly password: Secret;
      readonly header: Secret;
    }
  | {
      readonly kind: "oauth2";
      readonly clientId: string;
      readonly clientSecret: Secret;
    };

export interface Config {
  readonly baseUrl: BaseUrl;
  readonly auth: AuthConfig;
  readonly perMinute: number;
  readonly timeoutMs: number;
  readonly contact: string;
  readonly transport: "stdio" | "http";
  readonly port: number;
  readonly httpHost: string;
  readonly httpAuthToken: Secret | undefined;
  readonly cacheTtlSec: number;
  readonly maxLimit: number;
  readonly userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (query_or_hash).");
  }
  return brandBaseUrl(value.replace(/\/+$/, ""));
}

function basicHeader(username: string, password: string): Secret {
  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return brandSecret(`Basic ${encoded}`);
}

function resolveAuth(data: z.output<typeof EnvSchema>): AuthConfig {
  const mode = data.MAUTIC_AUTH_MODE;
  const username = data.MAUTIC_USERNAME;
  const password = data.MAUTIC_PASSWORD;
  const clientId = data.MAUTIC_CLIENT_ID;
  const clientSecret = data.MAUTIC_CLIENT_SECRET;
  const hasUser = username !== undefined;
  const hasPass = password !== undefined;
  const hasId = clientId !== undefined;
  const hasSecret = clientSecret !== undefined;
  const hasBasic = hasUser && hasPass;
  const hasOauth = hasId && hasSecret;

  if (mode === "basic") {
    if (!hasBasic) {
      throw new ConnectorError(
        "config",
        "Invalid environment: MAUTIC_USERNAME, MAUTIC_PASSWORD (required for basic).",
      );
    }
    return {
      kind: "basic",
      username,
      password: brandSecret(password),
      header: basicHeader(username, password),
    };
  }
  if (mode === "oauth2") {
    if (!hasOauth) {
      throw new ConnectorError(
        "config",
        "Invalid environment: MAUTIC_CLIENT_ID, MAUTIC_CLIENT_SECRET (required for oauth2).",
      );
    }
    return {
      kind: "oauth2",
      clientId,
      clientSecret: brandSecret(clientSecret),
    };
  }
  if (hasUser !== hasPass) {
    throw new ConnectorError(
      "config",
      "Invalid environment: MAUTIC_USERNAME, MAUTIC_PASSWORD (both required for basic).",
    );
  }
  if (hasId !== hasSecret) {
    throw new ConnectorError(
      "config",
      "Invalid environment: MAUTIC_CLIENT_ID, MAUTIC_CLIENT_SECRET (both required for oauth2).",
    );
  }
  if (hasBasic && hasOauth) {
    throw new ConnectorError(
      "config",
      "Invalid environment: MAUTIC_AUTH_MODE (both basic and oauth2 credentials are set).",
    );
  }
  if (hasBasic) {
    return {
      kind: "basic",
      username,
      password: brandSecret(password),
      header: basicHeader(username, password),
    };
  }
  if (hasOauth) {
    return {
      kind: "oauth2",
      clientId,
      clientSecret: brandSecret(clientSecret),
    };
  }
  throw new ConnectorError(
    "config",
    "Invalid environment: MAUTIC_USERNAME, MAUTIC_PASSWORD, MAUTIC_CLIENT_ID, MAUTIC_CLIENT_SECRET (set basic or oauth2 credentials).",
  );
}

function collectSecrets(auth: AuthConfig, httpAuthToken: Secret | undefined): string[] {
  const secrets: string[] = [];
  if (auth.kind === "basic") {
    secrets.push(auth.password, auth.header);
  } else {
    secrets.push(auth.clientSecret);
  }
  if (httpAuthToken !== undefined) secrets.push(httpAuthToken);
  return secrets;
}

function rejectSecretInPlainFields(
  auth: AuthConfig,
  baseUrl: BaseUrl,
  contact: string,
  userAgent: string,
  httpHost: string,
): void {
  const secrets = collectSecrets(auth, undefined);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    if (baseUrl.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (contains_secret).");
    }
    if (contact.includes(secret) || userAgent.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: MAUTIC_CONTACT (contains_secret).");
    }
    if (httpHost.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: MCP_HTTP_HOST (contains_secret).");
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const parsed = EnvSchema.safeParse({
    MAUTIC_BASE_URL: read(env, "MAUTIC_BASE_URL"),
    MAUTIC_AUTH_MODE: read(env, "MAUTIC_AUTH_MODE"),
    MAUTIC_USERNAME: read(env, "MAUTIC_USERNAME"),
    MAUTIC_PASSWORD: env["MAUTIC_PASSWORD"] === undefined ? undefined : env["MAUTIC_PASSWORD"],
    MAUTIC_CLIENT_ID: read(env, "MAUTIC_CLIENT_ID"),
    MAUTIC_CLIENT_SECRET:
      env["MAUTIC_CLIENT_SECRET"] === undefined ? undefined : env["MAUTIC_CLIENT_SECRET"],
    MAUTIC_PER_MINUTE: read(env, "MAUTIC_PER_MINUTE"),
    MAUTIC_TIMEOUT_MS: read(env, "MAUTIC_TIMEOUT_MS"),
    MAUTIC_CACHE_TTL_SEC: read(env, "MAUTIC_CACHE_TTL_SEC"),
    MAUTIC_MAX_LIMIT: read(env, "MAUTIC_MAX_LIMIT"),
    MAUTIC_CONTACT: read(env, "MAUTIC_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    MCP_HTTP_HOST: read(env, "MCP_HTTP_HOST"),
    MCP_HTTP_AUTH_TOKEN:
      env["MCP_HTTP_AUTH_TOKEN"] === undefined ? undefined : env["MCP_HTTP_AUTH_TOKEN"],
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  if (data.MAUTIC_BASE_URL === undefined) {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_BASE_URL (required).");
  }
  const auth = resolveAuth(data);
  const baseUrl = normalizeBaseUrl(data.MAUTIC_BASE_URL);
  const contact = data.MAUTIC_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: MAUTIC_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  const httpHost = data.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST;
  if (hasControlChar(httpHost) || httpHost.includes("/") || httpHost.includes("?")) {
    throw new ConnectorError("config", "Invalid environment: MCP_HTTP_HOST (invalid).");
  }
  rejectSecretInPlainFields(auth, baseUrl, contact, userAgent, httpHost);

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const httpAuthToken =
    data.MCP_HTTP_AUTH_TOKEN === undefined ? undefined : brandSecret(data.MCP_HTTP_AUTH_TOKEN);

  if (transport === "http" && !isLoopbackHost(httpHost) && httpAuthToken === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: MCP_HTTP_AUTH_TOKEN (required when MCP_HTTP_HOST is not loopback).",
    );
  }

  return {
    baseUrl,
    auth,
    perMinute: boundedInt(data.MAUTIC_PER_MINUTE, DEFAULT_PER_MINUTE, 1, 10_000, "MAUTIC_PER_MINUTE"),
    timeoutMs: boundedInt(data.MAUTIC_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 120_000, "MAUTIC_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 0, 65_535, "PORT"),
    httpHost,
    httpAuthToken,
    cacheTtlSec: boundedInt(
      data.MAUTIC_CACHE_TTL_SEC,
      DEFAULT_CACHE_TTL_SEC,
      0,
      86_400,
      "MAUTIC_CACHE_TTL_SEC",
    ),
    maxLimit: boundedInt(data.MAUTIC_MAX_LIMIT, DEFAULT_MAX_LIMIT, 1, HARD_MAX_LIMIT, "MAUTIC_MAX_LIMIT"),
    userAgent,
  };
}

export function secretValues(config: Config): string[] {
  return collectSecrets(config.auth, config.httpAuthToken);
}
