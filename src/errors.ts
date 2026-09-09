import { z } from "zod";
import type { Result } from "./contracts.js";

export class OperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function failure({
  error,
  sessionId,
  applied,
}: {
  error: unknown;
  sessionId?: string;
  applied?: string[];
}): Result {
  const code =
    error instanceof OperationError
      ? error.code
      : error instanceof z.ZodError
        ? "INVALID_ARGUMENT"
        : "OPERATION_FAILED";
  return {
    status: applied?.length ? "partial" : "failed",
    error_code: code,
    error: errorMessage(error),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(applied ? { applied } : {}),
    ...(code === "SESSION_OWNED_ELSEWHERE"
      ? {
          instruction:
            "Another engine owns this session. Use its owning app for this operation; idle does not release ownership.",
        }
      : {}),
    ...(code === "OUTCOME_UNKNOWN"
      ? {
          instruction:
            "Inspect the session before retrying; delivery may already have occurred.",
        }
      : {}),
  };
}
