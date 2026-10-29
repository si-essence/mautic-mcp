import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const BASE = "https://mautic.test";
export const USERNAME = "api-user";
export const PASSWORD = "mautic-pass-s3cret!";
export const CLIENT_ID = "oauth-client-id";
export const CLIENT_SECRET = "oauth-client-secret-99";
export const ACCESS_TOKEN = "oauth-access-token-99";
export const HTTP_TOKEN = "mcp-http-auth-token";

export const BASIC_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`, "utf8").toString("base64")}`;

export function basicEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MAUTIC_BASE_URL: BASE,
    MAUTIC_USERNAME: USERNAME,
    MAUTIC_PASSWORD: PASSWORD,
    ...extra,
  };
}

export function oauthEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MAUTIC_BASE_URL: BASE,
    MAUTIC_CLIENT_ID: CLIENT_ID,
    MAUTIC_CLIENT_SECRET: CLIENT_SECRET,
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(basicEnv(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function oauthRuntimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(oauthEnv(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
  rawBody: string | undefined;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  const contentType = headers.get("content-type");
  let rawBody: string | undefined;
  let body: unknown;
  if (init?.body === undefined) {
    rawBody = undefined;
    body = undefined;
  } else if (typeof init.body === "string") {
    rawBody = init.body;
    if (contentType !== null && contentType.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(init.body));
    } else {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
  } else {
    body = init.body;
  }
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    authorization: headers.get("authorization"),
    contentType,
    body,
    rawBody,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function parseForm(raw: string | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw ?? ""));
}

export function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}
