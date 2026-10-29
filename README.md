# mautic-mcp (Mautic MCP connector)

Local MCP connector for [Mautic](https://www.mautic.org/), the GPLv3 marketing automation platform. It talks to a Mautic instance you already run, over stdio or stateless Streamable HTTP. It does not start Mautic for you.

The connector uses Mautic's documented REST API only. It contains no Mautic source code.

TypeScript 6 is intentional. `typescript-eslint` strict type-aware rules need the JavaScript compiler API, which TypeScript 7 does not ship.

## Setup

```bash
npm install
npm run ci          # typecheck, lint, test, build
npm start           # stdio
npm run start:http  # Streamable HTTP at http://127.0.0.1:3000/mcp and /health
```

Copy `.env.example` to `.env` and export the variables in your shell, or set them in the client config. `MAUTIC_BASE_URL` is required. Point it at your Mautic origin, for example `https://mautic.example.com` or `http://127.0.0.1`.

Enable the API in Mautic before you connect:

1. Open **Settings > Configuration > API Settings**.
2. Turn **API enabled** on.
3. For basic auth, turn **Enable HTTP basic auth** on.
4. For OAuth2, open **Settings > API Credentials**, create an **OAuth 2** client, and copy the client id and secret.
5. Clear Mautic's cache after you change API settings.

Basic auth (`authentication.rst:8`, `authentication.rst:37`) sends `Authorization: Basic`. OAuth2 client credentials (`authentication.rst:46`, `authentication.rst:195`) `POST` to `{MAUTIC_BASE_URL}/oauth/v2/token` with `grant_type=client_credentials`, then send `Authorization: Bearer`. The connector caches the access token, refreshes it before `expires_in`, and retries the request once after a 401.

Claude Desktop or any stdio client:

```json
{
  "mcpServers": {
    "mautic": {
      "command": "node",
      "args": ["/workspace/connectors/mautic/dist/index.js"],
      "env": {
        "MAUTIC_BASE_URL": "https://mautic.example.com",
        "MAUTIC_USERNAME": "api-user",
        "MAUTIC_PASSWORD": "...",
        "MAUTIC_CONTACT": "you@example.com"
      }
    }
  }
}
```

OAuth2 instead of basic: set `MAUTIC_CLIENT_ID` and `MAUTIC_CLIENT_SECRET`. If both pairs are present, set `MAUTIC_AUTH_MODE` to `basic` or `oauth2`.

Docker binds `0.0.0.0` inside the container, so `MCP_HTTP_AUTH_TOKEN` is required (at least 16 characters):

```bash
docker build -t mautic-mcp .
docker run -p 127.0.0.1:3000:3000 \
  -e MAUTIC_BASE_URL=http://host.docker.internal \
  -e MAUTIC_USERNAME=api-user \
  -e MAUTIC_PASSWORD=your-password \
  -e MCP_HTTP_AUTH_TOKEN=at-least-16-chars \
  mautic-mcp
```

Register every tool with `registerConnectorTool`. Calling `server.registerTool` anywhere else fails lint.

## Environment

| Variable | Default | Role |
| --- | --- | --- |
| `MAUTIC_BASE_URL` | none, required | Mautic origin and optional path. `http` or `https`. No userinfo, query, or hash. API paths are under `{MAUTIC_BASE_URL}/api` (`getting_started.rst:56`) |
| `MAUTIC_AUTH_MODE` | inferred | `basic` or `oauth2`. Required when both credential pairs are set |
| `MAUTIC_USERNAME` | unset | Mautic user for basic auth |
| `MAUTIC_PASSWORD` | unset | Basic auth password. At least 8 characters. Never printed |
| `MAUTIC_CLIENT_ID` | unset | OAuth2 client id |
| `MAUTIC_CLIENT_SECRET` | unset | OAuth2 client secret. At least 8 characters. Never printed |
| `MAUTIC_CONTACT` | `contact@example.com` | Contact inside the User-Agent. Must not contain a secret |
| `MAUTIC_PER_MINUTE` | `60` | Local sliding-window cap |
| `MAUTIC_CACHE_TTL_SEC` | `60` | TTL for successful reads. `0` disables the cache. Writes are never cached and clear the cache |
| `MAUTIC_TIMEOUT_MS` | `20000` | Upstream timeout |
| `MAUTIC_MAX_LIMIT` | `100` | Cap for list `limit`. Hard max 500 |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. `--http` forces HTTP |
| `PORT` | `3000` | HTTP listen port. `0` selects an ephemeral port |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_AUTH_TOKEN` | unset | Bearer token for `/mcp`. Required when `MCP_HTTP_HOST` is not loopback. At least 16 characters |

Invalid values are reported by field name and issue code. The rejected value is not included in the error. Secrets never appear in logs, tool output, or error text, including upstream bodies that echo them.

## Tools

Routes are taken from Mautic developer docs (`devdocs.mautic.org` source, commit `bb8818f`, 2026-10-12) under `docs/rest_api/`. Paths below are relative to `{MAUTIC_BASE_URL}/api`. List tools accept `start` (default 0) and `limit` (default 30, capped by `MAUTIC_MAX_LIMIT`) and return `{total, start, limit, items, nextStart}`. Mautic collections are normalized to arrays. Keyed objects such as `{"total":"2","contacts":{"47":{...}}}` (`contacts.rst:296`) and real arrays both become `items`. An empty collection may be an object, for example `{"total":"0","contacts":{}}`. `total` may be a string or a number. Activity tools return `{total, page, limit, maxPages, events, filters, order, types}` instead of that page shape, and they do not trim `events` to `limit`.

`mautic_search_contacts` `search` uses Mautic search commands (`contacts.rst:243`), for example `email:*@example.com`, `tag:vip`, and `segment:alias`.

| Tool | Method and path | Source | Notes |
| --- | --- | --- | --- |
| `mautic_search_contacts` | `GET /contacts?search=&start=&limit=&orderBy=&orderByDir=&minimal=` | `contacts.rst:234` | Search commands at `contacts.rst:243` |
| `mautic_get_contact` | `GET /contacts/{id}` | `contacts.rst:57` | |
| `mautic_create_contact` | `POST /contacts/new` | `contacts.rst:444` | Field aliases plus `ipAddress`, `lastActive`, `owner`, `overwriteWithBlank`, `tags` |
| `mautic_update_contact` | `PATCH /contacts/{id}/edit` | `contacts.rst:570` | PATCH so a missing id fails (`contacts.rst:560`) |
| `mautic_add_contact_tags` | `PATCH /contacts/{id}/edit` | `contacts.rst:570`, `contacts.rst:603` | Body `{ tags: ["vip"] }` |
| `mautic_remove_contact_tags` | `PATCH /contacts/{id}/edit` | `contacts.rst:603` | Body `{ tags: ["-vip"] }`. Pass the tag name without the minus prefix |
| `mautic_list_segments` | `GET /segments` | `segments.rst:178` | Collection key `lists` (`segments.rst:223`) |
| `mautic_add_contact_to_segment` | `POST /segments/{segmentId}/contact/{contactId}/add` | `segments.rst:493` | |
| `mautic_remove_contact_from_segment` | `POST /segments/{segmentId}/contact/{contactId}/remove` | `segments.rst:614` | |
| `mautic_list_companies` | `GET /companies` | `companies.rst:410` | |
| `mautic_get_company` | `GET /companies/{id}` | `companies.rst:51` | |
| `mautic_create_company` | `POST /companies/new` | `companies.rst:738` | `companyname` required |
| `mautic_update_company` | `PATCH /companies/{id}/edit` | `companies.rst:962` | |
| `mautic_add_contact_to_company` | `POST /companies/{companyId}/contact/{contactId}/add` | `companies.rst:1040` | |
| `mautic_remove_contact_from_company` | `POST /companies/{companyId}/contact/{contactId}/remove` | `companies.rst:1075` | |
| `mautic_list_emails` | `GET /emails` | `emails.rst:303` | |
| `mautic_get_email` | `GET /emails/{id}` | `emails.rst:51` | |
| `mautic_get_email_stats` | `GET /emails/{id}` | `emails.rst:96`, `emails.rst:223` | Returns `sentCount`, `readCount`, `variantSentCount`, `variantReadCount`. Row-level stats: `mautic_get_stats` with table `email_stats` (`stats.rst:67`) |
| `mautic_send_email_to_contact` | `POST /emails/{id}/contact/{contactId}/send` | `emails.rst:734` | Optional `tokens` (`emails.rst:764`) |
| `mautic_send_email_to_segment` | `POST /emails/{id}/send` | `emails.rst:805` | Optional `listIds` (`emails.rst:817`) |
| `mautic_list_campaigns` | `GET /campaigns` | `campaigns.rst:232` | |
| `mautic_get_campaign` | `GET /campaigns/{id}` | `campaigns.rst:57` | |
| `mautic_add_contact_to_campaign` | `POST /campaigns/{campaignId}/contact/{contactId}/add` | `campaigns.rst:705` | |
| `mautic_remove_contact_from_campaign` | `POST /campaigns/{campaignId}/contact/{contactId}/remove` | `campaigns.rst:744` | |
| `mautic_list_forms` | `GET /forms` | `forms.rst:414` | |
| `mautic_get_form` | `GET /forms/{id}` | `forms.rst:51` | |
| `mautic_list_form_submissions` | `GET /forms/{formId}/submissions` | `forms.rst:1128` | |
| `mautic_list_stages` | `GET /stages` | `stages.rst:159` | |
| `mautic_change_contact_stage` | `POST /stages/{stageId}/contact/{contactId}/add` | `stages.rst:451` | |
| `mautic_adjust_contact_points` | `POST /contacts/{id}/points/plus/{points}` or `/points/minus/{points}` | `contacts.rst:987`, `contacts.rst:1043` | Optional `eventName`, `actionName` (`contacts.rst:1000`). Minus docs say `eventname` (`contacts.rst:1056`); 7.2.1 reads the camelCase names |
| `mautic_list_point_triggers` | `GET /points/triggers` | `_api_endpoint_point_triggers.md:147` | New `point_triggers.rst` is a stub. Collection key `triggers` |
| `mautic_list_point_actions` | `GET /points` | `_api_endpoint_point_actions.md:122` | New `point_actions.rst` is a stub. Collection key `points` |
| `mautic_list_notes` | `GET /notes` or `GET /contacts/{id}/notes` | `notes.rst:177`, `contacts.rst:1550` | `contact_id` selects the contact notes route |
| `mautic_create_note` | `POST /notes/new` | `notes.rst:254` | `lead`, `text`, optional `type` (`general`, `email`, `call`, `meeting`) and `dateTime` (`notes.rst:274`) |
| `mautic_list_reports` | `GET /reports` | `reports.rst:223` | |
| `mautic_get_report` | `GET /reports/{id}?dateFrom=&dateTo=&limit=&page=` | `reports.rst:65`, `reports.rst:69` | |
| `mautic_list_stat_tables` | `GET /stats` | `stats.rst:47` | |
| `mautic_get_stats` | `GET /stats/{table}?start=&limit=&order=&where=` | `stats.rst:512` | `order[]` and `where[]` (`stats.rst:530`, `stats.rst:621`) |
| `mautic_check_contact_dnc` | `GET /contacts/{id}` | `contacts.rst:57` | Returns `doNotContact` entries. Optional `channel` keeps one channel. Cross-check `_api_endpoint_contacts.md:142` |
| `mautic_add_contact_dnc` | `POST /contacts/{id}/dnc/{channel}/add` | `contacts.rst:775` | Channel `email` or `sms`. Optional `reason` 1, 2, or 3 (`contacts.rst:789`), `channelId` (`contacts.rst:791`), `comments` (`contacts.rst:793`). Cross-check `_api_endpoint_contacts.md:579` |
| `mautic_remove_contact_dnc` | `POST /contacts/{id}/dnc/{channel}/remove` | `contacts.rst:829` | Cross-check `_api_endpoint_contacts.md:606` |
| `mautic_get_contact_activity` | `GET /contacts/{id}/activity` | `contacts.rst:2000` | `filters[search]`, `filters[includeEvents][]`, `filters[excludeEvents][]`, `filters[dateFrom]`, `filters[dateTo]`, `order[0]`, `order[1]`, `page`, `limit` (`contacts.rst:1975`). Dates use `Y-m-d H:i:s`. Cross-check `_api_endpoint_contacts.md:1165` |
| `mautic_list_activity` | `GET /contacts/activity` | `contacts.rst:2146` | Same filters (`contacts.rst:2123`). The global query table does not list `limit`; the contact route does (`contacts.rst:1989`). Optional `limit` is sent for both. Cross-check `_api_endpoint_contacts.md:1522`. Deprecated events route: `contacts.rst:1849` |
| `mautic_list_assets` | `GET /assets` | `assets.rst:198` | Cross-check `_api_endpoint_assets.md:142` |
| `mautic_get_asset` | `GET /assets/{id}` | `assets.rst:59` | Cross-check `_api_endpoint_assets.md:67` |
| `mautic_list_webhook_triggers` | `GET /hooks/triggers` | `webhooks.rst:487` | Normalized to `{triggers:[{name,label,description}]}` sorted by name. Cross-check `_api_endpoint_webhooks.md:275` |
| `mautic_list_webhooks` | `GET /hooks` | `webhooks.rst:174` | Collection key `hooks` (`webhooks.rst:219`). `secret` is removed. Cross-check `_api_endpoint_webhooks.md:128` |
| `mautic_get_webhook` | `GET /hooks/{id}` | `webhooks.rst:51` | `secret` is removed (`webhooks.rst:138`). Cross-check `_api_endpoint_webhooks.md:63` |
| `mautic_create_webhook` | `POST /hooks/new` | `webhooks.rst:309` | `name`, `webhookUrl`, `triggers` (`webhooks.rst:323`). Optional `description`, `eventsOrderbyDir`, `isPublished` (`webhooks.rst:338`). The input does not accept `secret` (`webhooks.rst:341`). Cross-check `_api_endpoint_webhooks.md:174` |
| `mautic_delete_webhook` | `DELETE /hooks/{id}/delete` | `webhooks.rst:451` | Cross-check `_api_endpoint_webhooks.md:257` |

Read tools use `readOnlyHint: true`. Write and send tools use `readOnlyHint: false`. Add, update, tag, stage, and DNC-add tools set `idempotentHint: true`. Create, send, point-adjust, and webhook-create tools set `idempotentHint: false`. Remove tools, DNC remove, and webhook delete set `destructiveHint: true`.

## Confirm and dry-run

Every write and send tool's input includes `confirm: z.literal(true).optional()`. The only accepted value is the boolean `true`. `confirm: false` and `confirm: "true"` fail Zod and make no upstream call, including no OAuth token fetch.

When `confirm` is omitted, the tool does not call Mautic. It returns a preview:

```json
{
  "dryRun": true,
  "method": "POST",
  "path": "api/contacts/new",
  "body": { "email": "ada@example.com" },
  "summary": "Create a contact via POST /api/contacts/new."
}
```

One shared `WritePlan` is built by a pure function, then either previewed or executed. `method` is `POST`, `PATCH`, or `DELETE`. DELETE sends no body.

DNC add, DNC remove, webhook create, and webhook delete use that same confirm gate. A dry-run does not call Mautic, so webhook trigger names are checked only when `confirm` is true, against `GET /api/hooks/triggers`. Unknown names are an input error and are not posted. Webhook GET, list, create, and delete responses drop the signing `secret` before the result is returned or cached.

## Limits

- In-memory TTL cache (`MAUTIC_CACHE_TTL_SEC`, default 60 seconds) for reads. A cache hit does not spend the local rate limit. The cache is dropped when the process exits. Writes skip the cache and clear it after a successful call so later reads refetch.
- Local sliding window (`MAUTIC_PER_MINUTE`, default 60 requests per 60 seconds) around Mautic API calls. OAuth token fetch is a separate `POST` to `/oauth/v2/token` (`authentication.rst:195`).
- When the local window is full, the tool returns `isError` with a `[rate-limit]` message and a retry hint. Cached results are still served.
- Upstream limits still apply. HTTP 429 is `[rate-limit]` and honors `Retry-After`. HTTP 400 is `[input]`. HTTP 401 is `[auth]`. HTTP 403 is `[upstream]`. HTTP 404 is `[not-found]`. Mautic bodies `{"errors":[{"message","code","type","details"}]}` (`details` may be a field map or `[]`, and `type` may be null), `{"error":{"message","code"}}`, and OAuth `{"error","error_description"}` (`getting_started.rst:13`) are mapped into those codes. Field details are appended only when the message does not already include them.
- List `limit` is capped by `MAUTIC_MAX_LIMIT` (default 100, hard max 500).
- Response bodies larger than 1,000,000 characters are rejected.
- Passwords, client secrets, access tokens, and the Basic auth header are redacted from tool results, error text, and logs, including URL-encoded forms.

## HTTP security

HTTP mode binds `127.0.0.1` by default (`MCP_HTTP_HOST`). Loopback hosts are `127.0.0.1`, `::1`, and `localhost`. A non-loopback host refuses to start unless `MCP_HTTP_AUTH_TOKEN` is set (minimum 16 characters). When the token is set, every `/mcp` request must send `Authorization: Bearer <token>`. The compare is constant-time. A missing or wrong token returns 401. `/health` stays unauthenticated and returns `ok`.

The Docker image sets `MCP_HTTP_HOST=0.0.0.0`, so you must pass `MCP_HTTP_AUTH_TOKEN`. Publish the port on localhost only: `-p 127.0.0.1:3000:3000`.

## Tested against

Local Mautic 7.2.1 on PHP 8.4, 2026-10-17. The API and HTTP basic auth were enabled. An OAuth2 client-credentials client with the Administrator role was used. The mailer was `null://null` with the sync messenger, so email sends are discarded by Mautic and were exercised only for that reason. `scripts/live-smoke.mjs` called the built stdio server against `http://127.0.0.1:8080`.

## Live quirks

- Empty collections can be objects, not arrays. `total` can be a numeric string.
- Validation errors look like `{"errors":[{"code":400,"message":"...","details":{"field":["..."]}}]}`. `details` may be `[]`. HTTP 500 uses `"type": null`.
- Several write responses use integer `success: 1` (segment, company, and campaign membership, stage add, point adjust, and segment email send). Contact email send uses boolean `true`. The connector does not coerce these.
- `POST /emails/{id}/send` returns `{success, sentCount, failedRecipients}` (`emails.rst:829`). A repeat send returns `sentCount: 0` when every current member already has a stat row, and `email.sentCount` stays put. A member who has not received that email is counted.
- Point subtract docs name the body fields `eventname` and `actionname` (`contacts.rst:1056`). Mautic 7.2.1 ignores those lowercase names and stores the default labels. The connector sends `eventName` and `actionName` for both plus and minus (`contacts.rst:1000`).
- `eventsOrderbyDir` docs say `asc` or `desc` (`webhooks.rst:349`). Mautic 7.2.1 accepts only `ASC` or `DESC`. The connector uppercases the value.
- Mautic 7.2.1 stores unknown webhook trigger names. The connector rejects unknown names when `confirm` is true and does not POST them.
- Webhook GET, create, and delete responses include a signing `secret` (`webhooks.rst:138`, `webhooks.rst:341`). It is removed before the tool result and before the read cache.
- DNC add docs show a short object (`contacts.rst:801`). Mautic 7.2.1 returns the full contact. `mautic_check_contact_dnc` reads `GET /contacts/{id}` and returns the entries. DNC writes clear the read cache. The check tool caches the full contact, the same payload as `mautic_get_contact`, then returns only the entries.
- Contact fields are under `fields.all` or `fields.core`, not a top-level `firstname`. Tags are objects `{id, tag}`. Removing a tag sends the name with a minus prefix (`contacts.rst:603`).
- `GET /contacts/activity?limit=2` can return more events than `limit` while echoing `limit`. The connector does not trim `events`.
- There is no delete-contact or delete-company tool. A live smoke run can leave a throwaway contact, company, and note behind.

## License

This connector's code is MIT. See `LICENSE`. Copyright 2026 Issah Abubakari.

It is a separate program that talks to Mautic (GPLv3) only over its documented REST API. No Mautic code is copied or linked.

"Mautic" is a trademark of its owner, used only to describe compatibility. No endorsement is implied. This project does not include a Mautic logo.

User-Agent is `mautic-mcp/0.1.0 (<MAUTIC_CONTACT>)`. Point `MAUTIC_CONTACT` at a real address before production use. You are responsible for complying with the Mautic instance's own access policy.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Mautic project or its owners.
