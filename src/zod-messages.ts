/** Zod error text that never interpolates the rejected value. */
export function fixedError(message: string): () => string {
  return () => message;
}
