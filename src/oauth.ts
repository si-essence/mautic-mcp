import { z } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { brandSecret } from "./brand.js";
import { TOKEN_REFRESH_SKEW_MS } from "./constants.js";
import { ConnectorError } from "./errors.js";
import {
  mauticErrorMessage,
  publicSnippet,
  serializeForm,
  type AuthProvider,
} from "./http.js";
import type { Logger } from "./log.js";

const tokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.union([z.number(), z.string()]).optional(),
  })
  .loose();

export interface OAuthTokenCacheOptions {
  baseUrl: BaseUrl;
  clientId: string;
  clientSecret: Secret;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: string[];
  now: () => number;
  userAgent: string;
  logger: Logger;
  label: string;
}

export class OAuthTokenCache implements AuthProvider {
  private token: { value: Secret; expiresAtMs: number } | undefined;
  private inflight: Promise<Secret> | undefined;

  constructor(private readonly options: OAuthTokenCacheOptions) {}

  async header(): Promise<string> {
    const token = await this.getToken();
    return `Bearer ${token}`;
  }

  async onUnauthorized(): Promise<"retry" | "give_up"> {
    this.token = undefined;
    await this.getToken();
    return "retry";
  }

  async getToken(): Promise<Secret> {
    if (this.token !== undefined && this.options.now() < this.token.expiresAtMs) {
      return this.token.value;
    }
    if (this.inflight !== undefined) return this.inflight;
    const pending = this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = pending;
    return pending;
  }

  private async fetchToken(): Promise<Secret> {
    const url = new URL("oauth/v2/token", `${this.options.baseUrl}/`);
    const body = serializeForm({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("content-type", "application/x-www-form-urlencoded");
    headers.set("user-agent", this.options.userAgent);
    let response: Response;
    try {
      response = await this.options.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.options.timeoutMs / 1000));
        throw new ConnectorError(
          "timeout",
          `${this.options.label} token request timed out after ${seconds}s.`,
        );
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.options.secrets);
      throw new ConnectorError("upstream", `${this.options.label} token request failed: ${safe}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const snippet = publicSnippet(text, this.options.secrets);
      const fromBody = mauticErrorMessage(text);
      const detailText =
        fromBody === undefined ? snippet : publicSnippet(fromBody, this.options.secrets);
      const detail = detailText.length > 0 ? `: ${detailText}` : "";
      if (response.status === 401 || response.status === 400) {
        throw new ConnectorError("auth", `${this.options.label} token HTTP ${response.status}${detail}`);
      }
      throw new ConnectorError(
        "upstream",
        `${this.options.label} token HTTP ${response.status}${detail}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new ConnectorError("upstream", `${this.options.label} token response was not JSON.`);
    }
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.options.label} token response did not match the expected shape.`,
      );
    }
    const token = brandSecret(parsed.data.access_token);
    if (!this.options.secrets.includes(token)) this.options.secrets.push(token);
    const expiresIn = parseExpiresIn(parsed.data.expires_in);
    const lifetimeMs = Math.max(1_000, expiresIn * 1000 - TOKEN_REFRESH_SKEW_MS);
    this.token = { value: token, expiresAtMs: this.options.now() + lifetimeMs };
    return token;
  }
}

function parseExpiresIn(value: number | string | undefined): number {
  if (value === undefined) return 3600;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 3600;
  return Math.floor(n);
}

export function basicAuthProvider(header: Secret): AuthProvider {
  return {
    header: () => Promise.resolve(header),
    onUnauthorized: () => Promise.resolve("give_up"),
  };
}
