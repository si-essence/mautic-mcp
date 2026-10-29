import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { BASE, CLIENT_SECRET, PASSWORD, basicEnv, oauthEnv } from "./harness.js";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("loads basic auth and applies defaults", () => {
    const config = loadConfig(basicEnv(), []);
    expect(config.baseUrl).toBe(BASE);
    expect(config.auth.kind).toBe("basic");
    if (config.auth.kind !== "basic") throw new Error("expected basic");
    expect(config.auth.username).toBe("api-user");
    expect(config.perMinute).toBe(60);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.httpAuthToken).toBeUndefined();
    expect(config.cacheTtlSec).toBe(60);
    expect(config.maxLimit).toBe(100);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("loads oauth2 when client credentials are set", () => {
    const config = loadConfig(oauthEnv(), []);
    expect(config.auth.kind).toBe("oauth2");
    if (config.auth.kind !== "oauth2") throw new Error("expected oauth2");
    expect(config.auth.clientId).toBe("oauth-client-id");
  });

  it("honors MAUTIC_AUTH_MODE when both pairs are set", () => {
    const env = {
      ...basicEnv(),
      ...oauthEnv(),
      MAUTIC_AUTH_MODE: "basic",
    };
    const config = loadConfig(env, []);
    expect(config.auth.kind).toBe("basic");
  });

  it("lets --http override the transport", () => {
    expect(loadConfig(basicEnv({ MCP_TRANSPORT: "stdio" }), ["node", "app", "--http"]).transport).toBe(
      "http",
    );
    expect(loadConfig(basicEnv({ MCP_TRANSPORT: "http" }), []).transport).toBe("http");
  });

  it("rejects a missing MAUTIC_BASE_URL", () => {
    const message = messageOf(
      catchError(() => loadConfig({ MAUTIC_USERNAME: "api-user", MAUTIC_PASSWORD: PASSWORD }, [])),
    );
    expect(message).toContain("MAUTIC_BASE_URL");
    expect(message).toContain("required");
  });

  it("rejects neither credential pair and names the fields", () => {
    const message = messageOf(catchError(() => loadConfig({ MAUTIC_BASE_URL: BASE }, [])));
    expect(message).toContain("MAUTIC_USERNAME");
    expect(message).toContain("MAUTIC_PASSWORD");
    expect(message).toContain("MAUTIC_CLIENT_ID");
    expect(message).toContain("MAUTIC_CLIENT_SECRET");
  });

  it("rejects both credential pairs without MAUTIC_AUTH_MODE", () => {
    const message = messageOf(catchError(() => loadConfig({ ...basicEnv(), ...oauthEnv() }, [])));
    expect(message).toContain("MAUTIC_AUTH_MODE");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(CLIENT_SECRET);
  });

  it("rejects a partial basic pair", () => {
    const message = messageOf(
      catchError(() => loadConfig({ MAUTIC_BASE_URL: BASE, MAUTIC_USERNAME: "api-user" }, [])),
    );
    expect(message).toContain("MAUTIC_USERNAME");
    expect(message).toContain("MAUTIC_PASSWORD");
  });

  it("rejects a partial oauth2 pair", () => {
    const message = messageOf(
      catchError(() => loadConfig({ MAUTIC_BASE_URL: BASE, MAUTIC_CLIENT_ID: "oauth-client-id" }, [])),
    );
    expect(message).toContain("MAUTIC_CLIENT_ID");
    expect(message).toContain("MAUTIC_CLIENT_SECRET");
  });

  it("rejects basic mode without the basic pair", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ MAUTIC_BASE_URL: BASE, MAUTIC_AUTH_MODE: "basic", ...oauthEnv() }, []),
      ),
    );
    expect(message).toContain("MAUTIC_USERNAME");
    expect(message).toContain("MAUTIC_PASSWORD");
  });

  it("reports invalid fields without the rejected value or secrets", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig(basicEnv({ PORT: "nope", MCP_TRANSPORT: "sse", MAUTIC_PASSWORD: PASSWORD }), []),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects userinfo and query strings on the base url", () => {
    const userinfo = messageOf(
      catchError(() =>
        loadConfig(basicEnv({ MAUTIC_BASE_URL: "https://user:pass@example.invalid" }), []),
      ),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");

    const query = messageOf(
      catchError(() =>
        loadConfig(basicEnv({ MAUTIC_BASE_URL: `https://example.invalid/v1?token=${PASSWORD}` }), []),
      ),
    );
    expect(query).toContain("MAUTIC_BASE_URL");
    expect(query).not.toContain(PASSWORD);
  });

  it("rejects a base url or contact that contains the password", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig(basicEnv({ MAUTIC_BASE_URL: `https://example.invalid/${PASSWORD}` }), []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(PASSWORD);

    const inContact = messageOf(
      catchError(() => loadConfig(basicEnv({ MAUTIC_CONTACT: PASSWORD }), [])),
    );
    expect(inContact).toContain("MAUTIC_CONTACT");
    expect(inContact).not.toContain(PASSWORD);
  });

  it("requires MCP_HTTP_AUTH_TOKEN when HTTP binds a non-loopback host", () => {
    const missing = messageOf(
      catchError(() =>
        loadConfig(basicEnv({ MCP_TRANSPORT: "http", MCP_HTTP_HOST: "0.0.0.0" }), []),
      ),
    );
    expect(missing).toContain("MCP_HTTP_AUTH_TOKEN");
    expect(missing).toContain("loopback");

    const mapped = messageOf(
      catchError(() =>
        loadConfig(
          basicEnv({ MCP_TRANSPORT: "http", MCP_HTTP_HOST: "::ffff:127.0.0.1" }),
          [],
        ),
      ),
    );
    expect(mapped).toContain("MCP_HTTP_AUTH_TOKEN");

    const ok = loadConfig(
      basicEnv({
        MCP_TRANSPORT: "http",
        MCP_HTTP_HOST: "0.0.0.0",
        MCP_HTTP_AUTH_TOKEN: "mcp-http-auth-token",
      }),
      [],
    );
    expect(ok.httpHost).toBe("0.0.0.0");
    expect(ok.httpAuthToken).toBe("mcp-http-auth-token");
  });

  it("allows loopback HTTP without a bearer token", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const config = loadConfig(
        basicEnv({ MCP_TRANSPORT: "http", MCP_HTTP_HOST: host }),
        [],
      );
      expect(config.httpHost).toBe(host);
      expect(config.httpAuthToken).toBeUndefined();
    }
  });
});
