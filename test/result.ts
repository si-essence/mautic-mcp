import { z } from "zod";

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean().optional(),
});

export function readToolText(value: unknown): { text: string; isError: boolean } {
  const parsed = toolResultSchema.parse(value);
  const block = parsed.content[0];
  if (block === undefined) {
    throw new Error("tool result had no content");
  }
  return { text: block.text, isError: parsed.isError === true };
}
