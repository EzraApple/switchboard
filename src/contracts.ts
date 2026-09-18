import { z } from "zod";
import type { SearchPage } from "./search.js";

export const harnessSchema = z.enum(["codex", "claude"]);
export type Harness = z.infer<typeof harnessSchema>;
const sessionId = z
  .string()
  .regex(
    /^(codex:[0-9a-f-]{36}|claude:(?:(?:cse|session)_[A-Za-z0-9]+|local_[0-9a-f-]{36}))$/,
  )
  .describe("Native ID prefixed with its harness.");
const text = z
  .string()
  .refine((value) => value.trim().length > 0, "Must be nonempty text");
const limit = z.number().int().min(1).max(100);
export const schemas = {
  search_sessions: z.object({
    query: z.string().max(1000).default(""),
    harness: harnessSchema.optional(),
    archived: z.boolean().default(false),
    limit: limit.default(20),
  }),
  read_session: z.object({ session_id: sessionId, limit: limit.default(30) }),
  create_session: z.object({
    harness: harnessSchema,
    prompt: text,
    cwd: text.describe("Absolute workspace directory."),
    title: text.optional(),
    model: text.optional(),
  }),
  send_message: z.object({ session_id: sessionId, prompt: text }),
  update_session: z
    .object({
      session_id: sessionId,
      title: text.optional(),
      archived: z.boolean().optional(),
    })
    .refine(
      (input) => input.title !== undefined || input.archived !== undefined,
      "Provide title or archived",
    ),
  delete_session: z.object({ session_id: sessionId }),
};
export type Operation = keyof typeof schemas;
export type CreateInput = z.infer<typeof schemas.create_session>;
export type SearchInput = z.infer<typeof schemas.search_sessions>;
export type ReadInput = z.infer<typeof schemas.read_session>;
export type SendInput = z.infer<typeof schemas.send_message>;
export type UpdateInput = z.infer<typeof schemas.update_session>;
export type DeleteInput = z.infer<typeof schemas.delete_session>;
export type Result = Record<string, unknown>;
export type Summary = {
  session_id: string;
  native_id: string;
  harness: Harness;
  title: string;
  archived: boolean;
  updated_at?: string | number | null;
  cwd?: string;
} & Result;
export interface Adapter {
  search(input: SearchInput): Promise<Summary[] | SearchPage>;
  read(input: ReadInput): Promise<Result>;
  create(input: CreateInput): Promise<Result>;
  send(input: SendInput): Promise<Result>;
  update(input: UpdateInput): Promise<Result>;
  delete(input: DeleteInput): Promise<Result>;
  close(): void;
}
export function parseSessionId(value: string) {
  const [harness, nativeId] = value.split(":");
  const parsedHarness = harnessSchema.parse(harness);
  if (!nativeId) throw new Error("Missing native session ID");
  if (parsedHarness === "codex") z.uuid().parse(nativeId);
  else
    z.string()
      .regex(/^(?:(?:cse|session)_[A-Za-z0-9]+|local_[0-9a-f-]{36})$/)
      .parse(nativeId);
  return { harness: parsedHarness, nativeId };
}
export const descriptions: Record<Operation, string> = {
  search_sessions:
    "Search titles, directories, and user/assistant conversation text across both harnesses. All significant query words must match (stemmed and prefix-matched); results are relevance-ranked with match snippets. Empty query lists recent sessions. Check warnings for incomplete remote history or unavailable sources; reasoning and tool output are excluded.",
  read_session:
    "Read recent user/assistant text and status, excluding reasoning. Verify replies here: send acceptance is not completion.",
  create_session:
    "Create and prompt a session through the configured local engine transport without changing focus. cwd sets execution location; Desktop grouping and immediate visibility are not guaranteed. Claude requires workspace trust. model is the native model name. If created=true, inspect the returned ID instead of creating again.",
  send_message:
    "Send a follow-up while preserving native permission checks. Dormant Claude Desktop conversations with local transcripts are resumed in background Claude Code without opening Desktop. Returns submission, not completion. No automatic retry after uncertain delivery. Archived sessions must first be restored.",
  update_session:
    "Rename, archive, or restore a session. Check applied fields on partial failure. SESSION_OWNED_ELSEWHERE means use the owning app; idle does not release ownership. Refresh warnings do not undo changes.",
  delete_session:
    "Permanently delete a native session only when the user requested deletion. Archive offers reversible hiding. Ownership errors leave the session intact; refresh warnings do not undo successful deletion.",
};
