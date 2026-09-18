import { SessionQueue } from "../queue.js";
import { stat } from "node:fs/promises";
import { SessionSearchIndex, compareSessions } from "../search.js";
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
import { ClaudeBackground } from "./claude-background.js";
import { ClaudeAPI } from "./claude-api.js";
import { ClaudeWorkers } from "./claude-workers.js";
import {
  readClaudeTranscript,
  claudeTranscriptPath,
  readClaudeSearchText,
} from "./claude-transcript.js";
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
    > &
      Partial<Pick<ClaudeWorkers, "findEnvironment">> = new ClaudeWorkers(),
    private readonly desktop: Pick<
      ClaudeDesktopStore,
      "list"
    > = new ClaudeDesktopStore(),
    private readonly localIPC: Pick<
      ClaudeLocalIPC,
      "send"
    > = new ClaudeLocalIPC(),
    private readonly index = new SessionSearchIndex(),
    private readonly directoryFile = join(stateDirectory, "sessions.json"),
    private readonly background: Pick<
      ClaudeBackground,
      "wake"
    > = new ClaudeBackground(desktop),
  ) {}
  private readonly queue = new SessionQueue();
  private directoriesLoading: Promise<Record<string, string>> | undefined;
  private directories: Record<string, string> | undefined;
  private getDirectories() {
    return (this.directoriesLoading ??= this.loadDirectories().catch(
      (error) => {
        this.directoriesLoading = undefined;
        throw error;
      },
    ));
  }
  private async loadDirectories() {
    if (this.directories) return this.directories;
    const legacy = await readJson({
      path: join(legacyStateDirectory, "sessions.json"),
      schema: directorySchema,
      fallback: {},
    });
    return (this.directories = await readJson({
      path: this.directoryFile,
      schema: directorySchema,
      fallback: legacy,
    }));
  }
  private async saveDirectories() {
    await this.queue.run("directories", async () =>
      writeJson({
        path: this.directoryFile,
        value: await this.getDirectories(),
      }),
    );
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
    const warnings: string[] = [];
    const locals = await this.desktop.list();
    const remote = await this.listRemoteSessions(warnings);
    const candidates = collectSearchCandidates(
      locals,
      remote,
      await this.getDirectories(),
      input.archived,
    );
    const summaries = candidates.map(({ summary }) => summary);
    if (!input.query.trim())
      return {
        sessions: summaries.sort(compareSessions).slice(0, input.limit),
        warnings,
      };
    const deadline = Date.now() + 60_000;
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < candidates.length) {
          const candidate = candidates[next++]!;
          await this.indexSearchCandidate(
            candidate,
            remote,
            deadline,
            warnings,
          );
        }
      }),
    );
    return {
      sessions: this.index.search(input.query, summaries, input.limit),
      warnings,
    };
  }
  private async listRemoteSessions(warnings: string[]) {
    const remote = new Map<string, z.infer<typeof sessionSchema>>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
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
        for (const row of page.data) remote.set(remoteSessionId(row.id), row);
        cursor = page.next_cursor ?? undefined;
        if (!cursor) break;
        if (cursors.has(cursor)) {
          warnings.push(
            "Remote session listing returned a repeated cursor; listing is incomplete",
          );
          break;
        }
        cursors.add(cursor);
      }
      if (cursor && !warnings.length)
        warnings.push("Remote session listing reached its page limit");
    } catch (error) {
      warnings.push(
        `Remote sessions unavailable: ${error instanceof Error ? error.message : String(error)}; local Desktop history remains searchable`,
      );
    }
    return remote;
  }
  private async indexSearchCandidate(
    { summary, local }: SearchCandidate,
    remote: Map<string, z.infer<typeof sessionSchema>>,
    deadline: number,
    warnings: string[],
  ) {
    try {
      const path = local && claudeTranscriptPath(local);
      const info = path
        ? await stat(path).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          })
        : undefined;
      if (path && info) {
        await this.index.sync(
          summary,
          JSON.stringify([path, info.size, info.mtimeMs]),
          () => readClaudeSearchText(path),
        );
      } else if (
        !summary.native_id.startsWith("local_") &&
        remote.has(summary.native_id)
      ) {
        // Active sessions can acquire events without updating their title metadata.
        const source = remote.get(summary.native_id)!;
        const signature = JSON.stringify([
          source.updated_at,
          source.last_event_at,
          source.connection_status === "connected"
            ? Math.floor(Date.now() / 30_000)
            : null,
        ]);
        await this.index.sync(summary, signature, async () =>
          (
            await this.remoteMessages(summary.native_id, {
              all: true,
              deadline,
            })
          )
            .map((message) => message.text)
            .join("\n"),
        );
      } else {
        warnings.push(
          `${summary.session_id}: no transcript available; only metadata was searched`,
        );
        await this.index.sync(summary, "metadata", async () => "");
      }
    } catch (error) {
      warnings.push(
        `${summary.session_id}: history unavailable (${error instanceof Error ? error.message : String(error)}); only metadata was searched`,
      );
      await this.index.sync(summary, "unavailable", async () => "");
    }
  }
  private async remoteMessages(
    nativeId: string,
    options: { all?: boolean; deadline?: number } = {},
  ) {
    const events: z.infer<typeof eventSchema>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      if (options.deadline && Date.now() >= options.deadline)
        throw new Error(
          "History indexing time budget reached; repeat the search to continue",
        );
      const params = new URLSearchParams({
        limit: "100",
        ...(cursor ? { cursor } : {}),
      });
      const response = z
        .object({
          data: z.array(z.unknown()),
          next_cursor: z.string().nullish(),
        })
        .parse(
          await this.api.request({
            method: "GET",
            path: `/v1/code/sessions/${nativeId}/events?${params}`,
          }),
        );
      events.push(
        ...response.data.flatMap((value) => {
          const parsed = eventSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        }),
      );
      cursor = response.next_cursor ?? undefined;
      if (cursor && cursors.has(cursor))
        throw new Error("Remote history returned a repeated cursor");
      if (cursor) cursors.add(cursor);
    } while (options.all && cursor);
    const seen = new Set<number>();
    return events
      .sort((left, right) => left.sequence_num - right.sequence_num)
      .flatMap((event) => {
        if (seen.has(event.sequence_num)) return [];
        seen.add(event.sequence_num);
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
    const messages = await this.remoteMessages(nativeId);
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
    return this.serialize(input.session_id, () =>
      this.sendMessage(input, newlyCreated),
    );
  }
  private async serialize<T>(sessionId: string, action: () => Promise<T>) {
    const nativeId = parseSessionId(sessionId).nativeId;
    const remoteId = remoteSessionId(nativeId);
    const local = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === nativeId ||
        [...row.bridgeSessionIds, row.liveBridgeSessionId].some(
          (id) => id && remoteSessionId(id) === remoteId,
        ),
    );
    return this.queue.run(local?.sessionId ?? remoteId, action);
  }
  private async sendMessage(
    input: SendInput,
    newlyCreated = false,
  ): Promise<Result> {
    const requestedId = parseSessionId(input.session_id).nativeId;
    const owner = (await this.desktop.list()).find(
      (row) =>
        row.sessionId === requestedId ||
        [...row.bridgeSessionIds, row.liveBridgeSessionId].some(
          (id) => id && remoteSessionId(id) === remoteSessionId(requestedId),
        ),
    );
    if (owner && !owner.livePid && owner.cliSessionId) {
      if (owner.isArchived)
        throw new Error("Unarchive the session before sending");
      const resumed = await this.background.wake(owner);
      return {
        ...(await this.localIPC.send(resumed, input.prompt)),
        session_id: input.session_id,
        resumed: true,
        resume_transport: "claude_background_cli",
      };
    }
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
      await this.reconnectSession(row, cwd);
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
  private async reconnectSession(
    row: z.infer<typeof sessionSchema>,
    cwd: string,
  ) {
    if (row.connection_status === "connected") return;
    const environment = await this.workers.findEnvironment?.(cwd);
    if (!environment) {
      await this.workers.resume({ cwd, nativeId: row.id });
      return;
    }
    if (row.environment_id !== environment)
      throw new OperationError(
        "CLAUDE_ENVIRONMENT_UNAVAILABLE",
        "This chat belongs to an older Claude environment; a different environment now serves its folder. Switchboard cannot resume it without disrupting other sessions. No message was sent.",
      );
    await this.api.request({
      method: "POST",
      path: `/v1/environments/${environment}/bridge/reconnect`,
      body: { session_id: row.id },
    });
  }
  async update(input: UpdateInput): Promise<Result> {
    return this.serialize(input.session_id, () => this.updateSession(input));
  }
  private async updateSession(input: UpdateInput): Promise<Result> {
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
          if (cwd)
            await this.reconnectSession(await this.getSession(nativeId), cwd);
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
    return this.serialize(input.session_id, () => this.deleteSession(input));
  }
  private async deleteSession(input: DeleteInput): Promise<Result> {
    await this.requireRemoteLifecycle(input.session_id);
    const { nativeId } = parseSessionId(input.session_id);
    await this.api.request({
      method: "DELETE",
      path: `/v1/code/sessions/${nativeId}`,
    });
    this.workers.forget(nativeId);
    const result: Result = { session_id: input.session_id, status: "deleted" };
    try {
      this.index.remove(input.session_id);
    } catch {
      result.warning = "Session deleted; local search cache cleanup failed";
    }
    return result;
  }
  close() {
    this.workers.close();
    this.index.close();
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

type SearchCandidate = { summary: Summary; local?: DesktopSession };
function collectSearchCandidates(
  locals: DesktopSession[],
  remote: Map<string, z.infer<typeof sessionSchema>>,
  directories: Record<string, string>,
  archived: boolean,
) {
  const mappedIds = new Set(
    locals.flatMap((row) =>
      [
        ...row.bridgeSessionIds,
        ...(row.liveBridgeSessionId ? [row.liveBridgeSessionId] : []),
      ].map(remoteSessionId),
    ),
  );
  const candidates: SearchCandidate[] = [];
  for (const local of locals) {
    if (local.isArchived !== archived) continue;
    const id = local.liveBridgeSessionId ?? local.bridgeSessionIds.at(-1);
    const row = id ? remote.get(remoteSessionId(id)) : undefined;
    const nativeId = id ? remoteSessionId(id) : local.sessionId;
    candidates.push({
      local,
      summary: row
        ? desktopSummary(row, local)
        : {
            session_id: `claude:${nativeId}`,
            native_id: nativeId,
            harness: "claude",
            title: local.title,
            cwd: local.cwd,
            archived: local.isArchived,
            updated_at: (local.lastActivityAt ?? 0) / 1000,
            surface: "claude_desktop",
            connection_status: id ? "unknown" : "local_only",
          },
    });
  }
  for (const row of remote.values()) {
    if (
      !mappedIds.has(remoteSessionId(row.id)) &&
      (row.status === "archived") === archived
    )
      candidates.push({
        summary: { ...summarize(row), cwd: directories[row.id] },
      });
  }
  return candidates;
}
