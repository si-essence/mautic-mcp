import type { ZodType } from "zod";
import { z } from "zod";
import type { HttpClient, QueryMap } from "./http.js";
import { fixedError } from "./zod-messages.js";

const confirmError = fixedError("confirm must be the boolean true");

/** The only accepted confirm value is the boolean `true`. `false` and `"true"` fail Zod. */
export const confirmField = z
  .literal(true, { error: confirmError })
  .optional()
  .describe(
    "Set to the boolean true to execute the write. Omit this field for a dry-run preview. false and the string true are rejected.",
  );

export interface RequestWritePlan {
  readonly kind: "request";
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: Readonly<Record<string, unknown>> | undefined;
  readonly summary: string;
}

export type WritePlan = RequestWritePlan;

export type WriteDecision =
  | { readonly kind: "preview"; readonly payload: Record<string, unknown> }
  | { readonly kind: "execute" };

export function previewWrite(plan: WritePlan): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dryRun: true,
    method: plan.method,
    path: plan.path,
    summary: plan.summary,
  };
  if (plan.query !== undefined) payload["query"] = plan.query;
  if (plan.body !== undefined) payload["body"] = plan.body;
  return payload;
}

export function decideWrite(confirm: true | undefined, plan: WritePlan): WriteDecision {
  if (confirm === true) return { kind: "execute" };
  return { kind: "preview", payload: previewWrite(plan) };
}

export async function runWrite<T>(
  client: HttpClient,
  plan: RequestWritePlan,
  schema: ZodType<T>,
): Promise<T> {
  const request = {
    path: plan.path,
    query: plan.query,
    body: plan.body,
    ttlSec: 0,
    invalidate: true,
  };
  if (plan.method === "POST") return client.postJson(request, schema);
  if (plan.method === "PATCH") return client.patchJson(request, schema);
  plan.method satisfies "DELETE";
  return client.deleteJson(
    { path: plan.path, query: plan.query, ttlSec: 0, invalidate: true },
    schema,
  );
}

export async function applyWrite(
  client: HttpClient,
  confirm: true | undefined,
  plan: WritePlan,
  schema: ZodType,
  wrap: (data: unknown) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const decision = decideWrite(confirm, plan);
  if (decision.kind === "preview") return decision.payload;
  return wrap(await runWrite(client, plan, schema));
}
