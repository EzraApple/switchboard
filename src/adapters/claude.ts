import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  parseSessionId,
  type Adapter,
  type CreateInput,
  type DeleteInput,
  type ReadInput,
  type Result,
  type SearchInput,
  type SendInput,
  type Summary,
  type UpdateInput,
} from "../contracts.js";
import { failure, OperationError } from "../errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { legacyStateDirectory, stateDirectory } from "../config.js";
import { readJson, writeJson } from "../files.js";
import { ClaudeAPI } from "./claude-api.js";
import { ClaudeWorkers } from "./claude-workers.js";
import { readClaudeTranscript } from "./claude-transcript.js";
import { ClaudeLocalIPC } from "./claude-local-ipc.js";
import { claudePeerMessage } from "./claude-message.js";
import {
  ClaudeDesktopStore,
  remoteSessionId,
  type DesktopSession,
} from "./claude-desktop-store.js";

const sessionSchema = z
  .object({
    id: z.string(),
    title: z.string().default(""),
    status: z.string(),
    worker_status: z.string().nullish(),
    connection_status: z.string().nullish(),
    updated_at: z.string().nullish(),
    last_event_at: z.string().nullish(),
    environment_id: z.string().nullish(),
    config: z.object({ origin: z.unknown().optional() }).loose().optional(),
  })
  .loose();
const pageSchema = z.object({
  data: z.array(sessionSchema),
  next_cursor: z.string().nullish(),
});
const contentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
]);
const eventSchema = z.object({
  sequence_num: z.coerce.number().default(0),
  created_at: z.string().optional(),
  payload: z
    .object({
      message: z
        .object({ role: z.enum(["user", "assistant"]), content: contentSchema })
        .optional(),
    })
    .loose(),
});
const directorySchema = z.record(z.string(), z.string());
export class ClaudeAdapter implements Adapter {
  constructor(
    private readonly api: Pick<ClaudeAPI, "request"> = new ClaudeAPI(),
    private readonly workers: Pick<
      ClaudeWorkers,
      "environment" | "resume" | "forget" | "close"
    > = new ClaudeWorkers(),
    private readonly desktop: Pick<
      ClaudeDesktopStore,
      "list"
    > = new ClaudeDesktopStore(),
    private readonly localIPC: Pick<
      ClaudeLocalIPC,
      "send"
    > = new ClaudeLocalIPC(),
  ) {}
  private directories: Record<string, string> | undefined;
  private async getDirectories() {
    if (this.directories) return this.directories;
    const legacy = await readJson({
      path: join(legacyStateDirectory, "sessions.json"),
      schema: directorySchema,
      fallback: {},
    });
    return (this.directories = await readJson({
      path: join(stateDirectory, "sessions.json"),
      schema: directorySchema,
      fallback: legacy,
    }));
  }
  private async saveDirectories() {
    await writeJson({
      path: join(stateDirectory, "sessions.json"),
      value: await this.getDirectories(),
    });
  }
  private async getSession(nativeId: string) {
    const response = z
      .object({
        session: sessionSchema.optional(),
        response_shape: sessionSchema.optional(),
      })
      .parse(
        await this.api.request({
          method: "GET",
          path: `/v1/code/sessions/${nativeId}`,
        }),
      );
    const row = response.session ?? response.response_shape;
    if (!row) throw new Error("Claude API did not return a session");
    return row;
  }
  private async resolve(nativeId: string) {
    const remoteId = remoteSessionId(nativeId);
    const local = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === nativeId ||
        (row.liveBridgeSessionId !== undefined &&
          remoteSessionId(row.liveBridgeSessionId) === remoteId) ||
        row.bridgeSessionIds.some((id) => remoteSessionId(id) === remoteId),
    );
    if (!local)
      return { row: await this.getSession(remoteId), local: undefined };
    // History is append-only. The last bridge is the Desktop conversation's current identity.
    const currentId =
      local.liveBridgeSessionId ?? local.bridgeSessionIds.at(-1);
    if (!currentId)
      throw new OperationError(
        "CLAUDE_NOT_CONNECTED",
        `Claude Desktop session "${local.title}" is not running, and Switchboard has no available connection to start it in the background. No message was sent.`,
      );
    return { row: await this.getSession(remoteSessionId(currentId)), local };
  }
  async search(input: SearchInput) {
    const sessions: Summary[] = [];
    const locals = await this.desktop.list();
    const mappedIds = new Set(
      locals.flatMap((row) =>
        [
          ...row.bridgeSessionIds,
          ...(row.liveBridgeSessionId ? [row.liveBridgeSessionId] : []),
        ].map(remoteSessionId),
      ),
    );
    for (const local of locals) {
      if (
        local.isArchived !== input.archived ||
        !`${local.title}\n${local.cwd}`
          .toLowerCase()
          .includes(input.query.toLowerCase())
      )
        continue;
      const id = local.liveBridgeSessionId ?? local.bridgeSessionIds.at(-1);
      if (!id) {
        sessions.push({
          session_id: `claude:${local.sessionId}`,
          native_id: local.sessionId,
          harness: "claude",
          title: local.title,
          cwd: local.cwd,
          archived: local.isArchived,
          updated_at: (local.lastActivityAt ?? 0) / 1000,
          surface: "claude_desktop",
          connection_status: "local_only",
        });
        continue;
      }
      try {
        sessions.push(
          desktopSummary(await this.getSession(remoteSessionId(id)), local),
        );
      } catch (error) {
        sessions.push({
          session_id: `claude:${remoteSessionId(id)}`,
          native_id: remoteSessionId(id),
          harness: "claude",
          title: local.title,
          cwd: local.cwd,
          archived: local.isArchived,
          surface: "claude_desktop",
          connection_status: "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const params = new URLSearchParams({
        limit: "100",
        include_trigger_sessions: "true",
        ...(cursor ? { cursor } : {}),
      });
      const page = pageSchema.parse(
        await this.api.request({
          method: "GET",
          path: `/v1/code/sessions?${params}`,
        }),
      );
      for (const row of page.data)
        if (
          !mappedIds.has(row.id) &&
          (row.status === "archived") === input.archived &&
          row.title.toLowerCase().includes(input.query.toLowerCase())
        )
          sessions.push(summarize(row));
      cursor = page.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return sessions;
  }
  async read(input: ReadInput): Promise<Result> {
    const requestedId = parseSessionId(input.session_id).nativeId;
    const owner = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === requestedId ||
        [...row.bridgeSessionIds, row.liveBridgeSessionId].some(
          (id) => id && remoteSessionId(id) === remoteSessionId(requestedId),
        ),
    );
    if (owner) {
      const history = await readClaudeTranscript(owner, input.limit);
      if (history)
        return {
          session_id: input.session_id,
          title: owner.title,
          cwd: owner.cwd,
          archived: owner.isArchived,
          surface: "claude_desktop",
          owner_running: Boolean(owner.livePid),
          ...history,
        };
    }
    const resolved = await this.resolve(
      parseSessionId(input.session_id).nativeId,
    );
    const { row, local } = resolved,
      nativeId = row.id;
    const response = z.object({ data: z.array(z.unknown()) }).parse(
      await this.api.request({
        method: "GET",
        path: `/v1/code/sessions/${nativeId}/events?limit=100`,
      }),
    );
    const events = response.data
      .flatMap((value) => {
        const parsed = eventSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .sort((left, right) => left.sequence_num - right.sequence_num);
    const messages = events.flatMap((event) => {
      const message = event.payload.message;
      if (!message) return [];
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((part) =>
                part.type === "text" && part.text ? [part.text] : [],
              )
              .join("\n");
      return text
        ? [{ role: message.role, text, timestamp: event.created_at }]
        : [];
    });
    return {
      ...desktopSummary(row, local),
      cwd: local?.cwd ?? (await this.getDirectories())[nativeId],
      messages: messages.slice(-input.limit),
      event_window: 100,
    };
  }
  async create(input: CreateInput): Promise<Result> {
    const environmentId = await this.workers.environment(input.cwd);
    const response = z.object({ session: z.object({ id: z.string() }) }).parse(
      await this.api.request({
        method: "POST",
        path: "/v1/code/sessions",
        body: {
          title: input.title ?? "Switchboard session",
          events: [],
          environment_id: environmentId,
          config: {
            sources: [],
            ...(input.model ? { model: input.model } : {}),
          },
          tags: ["switchboard"],
        },
      }),
    );
    const nativeId = response.session.id,
      sessionId = `claude:${nativeId}`;
    try {
      (await this.getDirectories())[nativeId] = input.cwd;
      await this.saveDirectories();
      return {
        ...(await this.send(
          { session_id: sessionId, prompt: input.prompt },
          true,
        )),
        created: true,
      };
    } catch (error) {
      return {
        ...failure({ error, sessionId }),
        created: true,
        instruction:
          "Session exists. Inspect before sending again; do not repeat creation.",
      };
    }
  }
  async send(input: SendInput, newlyCreated = false): Promise<Result> {
    const requestedId = parseSessionId(input.session_id).nativeId;
    const owner = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === requestedId ||
        [...row.bridgeSessionIds, row.liveBridgeSessionId].some(
          (id) => id && remoteSessionId(id) === remoteSessionId(requestedId),
        ),
    );
    if (owner?.livePid && owner.messagingSocketPath) {
      if (owner.isArchived)
        throw new Error("Unarchive the session before sending");
      return {
        ...(await this.localIPC.send(owner, input.prompt)),
        session_id: input.session_id,
      };
    }
    let { row, local } = await this.resolve(
      parseSessionId(input.session_id).nativeId,
    );
    const nativeId = row.id;
    if (local ? local.isArchived : row.status === "archived")
      throw new Error("Unarchive the session before sending");
    const cwd = local?.cwd ?? (await this.getDirectories())[nativeId];
    if (
      (row.connection_status !== "connected" || row.status === "archived") &&
      !newlyCreated
    ) {
      if (!cwd || local?.remoteControlUserEnabled === false)
        throw new OperationError(
          "CLAUDE_NOT_CONNECTED",
          "Claude is disconnected and cannot be automatically reconnected. Enable Remote Control in its owning app. No message was sent.",
        );
      if (local) {
        throw new OperationError(
          "CLAUDE_DESKTOP_RECONNECT_REQUIRED",
          "This Claude chat is not running, and Switchboard has no available connection to start it in the background. No message was sent.",
        );
      }
      await this.workers.resume({ cwd, nativeId });
      for (let attempt = 0; attempt < 20; attempt++) {
        row = await this.getSession(nativeId);
        if (row.connection_status === "connected") break;
        await delay(500);
      }
      if (row.connection_status !== "connected")
        throw new OperationError(
          "CLAUDE_NOT_CONNECTED",
          "Claude worker started but its session did not connect. No message was sent.",
        );
    }
    const eventId = randomUUID();
    const receipt = await this.api.request({
      method: "POST",
      path: `/v1/code/sessions/${nativeId}/events`,
      body: {
        events: [
          {
            event_id: eventId,
            event_type: "user",
            payload: {
              type: "user",
              uuid: eventId,
              session_id: nativeId,
              message: {
                role: "user",
                content: [
                  { type: "text", text: claudePeerMessage(input.prompt) },
                ],
              },
            },
          },
        ],
      },
    });
    return {
      session_id: input.session_id,
      remote_session_id: `claude:${nativeId}`,
      status: "accepted",
      connection_status: row.connection_status,
      delivery:
        row.connection_status === "connected"
          ? "submitted_to_connected_session"
          : "awaiting_initial_worker",
      sender: "Switchboard",
      authority: "peer",
      event_id: eventId,
      transport: "claude_remote_control",
      receipt,
    };
  }
  async update(input: UpdateInput): Promise<Result> {
    await this.requireRemoteLifecycle(input.session_id);
    const { nativeId } = parseSessionId(input.session_id),
      applied: string[] = [];
    try {
      if (input.title !== undefined) {
        await this.api.request({
          method: "PUT",
          path: `/v1/code/sessions/${nativeId}`,
          body: { title: input.title },
        });
        applied.push("title");
      }
      if (input.archived !== undefined) {
        await this.api.request({
          method: "POST",
          path: `/v1/code/sessions/${nativeId}/${input.archived ? "archive" : "unarchive"}`,
          body: {},
        });
        applied.push("archived");
        if (!input.archived) {
          const cwd = (await this.getDirectories())[nativeId];
          if (cwd) await this.workers.resume({ cwd, nativeId });
          else
            return {
              session_id: input.session_id,
              status: "updated",
              applied,
              warning:
                "Session restored. Reconnect its original worker before messaging.",
            };
        }
      }
      return { session_id: input.session_id, status: "updated", applied };
    } catch (error) {
      return failure({ error, sessionId: input.session_id, applied });
    }
  }
  async delete(input: DeleteInput): Promise<Result> {
    await this.requireRemoteLifecycle(input.session_id);
    const { nativeId } = parseSessionId(input.session_id);
    await this.api.request({
      method: "DELETE",
      path: `/v1/code/sessions/${nativeId}`,
    });
    this.workers.forget(nativeId);
    return { session_id: input.session_id, status: "deleted" };
  }
  close() {
    this.workers.close();
  }
  private async requireRemoteLifecycle(sessionId: string) {
    const nativeId = parseSessionId(sessionId).nativeId;
    const remoteId = remoteSessionId(nativeId);
    const local = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === nativeId ||
        row.bridgeSessionIds.some((id) => remoteSessionId(id) === remoteId) ||
        (row.liveBridgeSessionId &&
          remoteSessionId(row.liveBridgeSessionId) === remoteId),
    );
    if (local)
      throw new OperationError(
        "SESSION_OWNED_ELSEWHERE",
        "Claude Desktop owns this conversation's title and lifecycle. Changing only its remote mirror would not update the Desktop conversation. Use Claude Desktop for this operation.",
      );
  }
}
function desktopSummary(
  row: z.infer<typeof sessionSchema>,
  local?: DesktopSession,
): Summary {
  if (!local) return summarize(row);
  return {
    ...summarize(row),
    title: local.title,
    remote_title: row.title,
    cwd: local.cwd,
    archived: local.isArchived,
    remote_archived: row.status === "archived",
    desktop_session_id: local.sessionId,
    cli_session_id: local.cliSessionId,
    surface: "claude_desktop",
    updated_at: Math.max(
      (local.lastActivityAt ?? 0) / 1000,
      Date.parse(row.updated_at ?? row.last_event_at ?? "") / 1000 || 0,
    ),
  };
}
function summarize(row: z.infer<typeof sessionSchema>): Summary {
  return {
    session_id: `claude:${row.id}`,
    native_id: row.id,
    harness: "claude",
    title: row.title,
    archived: row.status === "archived",
    status: row.worker_status,
    connection_status: row.connection_status,
    updated_at: row.updated_at ?? row.last_event_at,
    environment_id: row.environment_id,
    surface: "remote_control",
    origin: row.config?.origin,
  };
}
