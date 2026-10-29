import { redact } from "./redact.js";

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export function createLogger(
  secrets: readonly string[],
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): Logger {
  const emit = (level: "info" | "error", message: string): void => {
    write(redact(`${level} ${message}`, secrets));
  };
  return {
    info: (message) => {
      emit("info", message);
    },
    error: (message) => {
      emit("error", message);
    },
  };
}
