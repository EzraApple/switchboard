import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, stateDirectory } from "../config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
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
  type UpdateInput,
} from "../contracts.js";
import { errorMessage, failure, OperationError } from "../errors.js";
import { CodexEngine } from "./codex-engine.js";
import { CodexStore } from "./codex-store.js";
import {
  CodexIPC,
  DesktopRejection,
  DesktopUnavailableError,
} from "./codex-ipc.js";

const executeFile = promisify(execFile);
const projectsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      roots: z.array(z.object({ path: z.string() })),
    }),
  ),
  nextCursor: z.string().nullish(),
});
type Engine = Pick<CodexEngine, "call"> & {
  close(): void | Promise<void>;
  transport?: string;
};
type Desktop = Pick<CodexIPC, "send" | "broadcast" | "close" | "findOwner">;
export class CodexAdapter implements Adapter {
  private engineInstance: Engine | undefined;
  private readonly owned = new Map<string, Engine>();
  private readonly turnVersions = new Map<string, number>();
  private readonly turnStates = new Map<string, string | null>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly createEngine: (
    onNotification: (method: string, params: unknown) => void,
  ) => Engine;
  private readonly store: Pick<CodexStore, "search" | "get" | "read">;
  private readonly openDesktop: () => Promise<Desktop>;
  constructor(
    options: {
      engine?: Engine;
      createEngine?: (
        onNotification: (method: string, params: unknown) => void,
      ) => Engine;
      store?: Pick<CodexStore, "search" | "get" | "read">;
      openDesktop?: () => Promise<Desktop>;
    } = {},
  ) {
    this.engineInstance = options.engine;
    this.createEngine =
      options.createEngine ??
      (options.engine
        ? () => options.engine!
        : (notify) => new CodexEngine(notify, sharedDaemonSocket()));
    this.store = options.store ?? new CodexStore();
    this.openDesktop = options.openDesktop ?? (() => CodexIPC.open());
  }
  private get engine() {
    return (this.engineInstance ??= new CodexEngine(
      undefined,
      sharedDaemonSocket(),
    ));
  }
  async search(input: SearchInput) {
    return this.store.search(input);
  }
  async read(input: ReadInput) {
    const transcript = await this.store.read(input);
    const { nativeId } = parseSessionId(input.session_id);
    const connection =
      this.owned.get(nativeId)?.transport ??
      (this.owned.has(nativeId) ? "codex_app_server" : "none");
    const state = {
      ...transcript,
      switchboard_connection: connection,
      ...(this.turnStates.has(nativeId)
        ? {
            status: this.turnStates.get(nativeId) ? "active" : "idle",
            turn_id: this.turnStates.get(nativeId),
          }
        : {}),
    };
    try {
      const desktop = await this.openDesktop();
      try {
        const owner = await desktop.findOwner(nativeId);
        return {
          ...state,
          desktop_owner_available: owner !== null,
        };
      } finally {
        desktop.close();
      }
    } catch (error) {
      return {
        ...state,
        desktop_owner_available: null,
        ownership_error: errorMessage(error),
      };
    }
  }
  async create(input: CreateInput): Promise<Result> {
    const projectId = await this.findProject(input.cwd);
    const engine = this.newTurnEngine();
    let created;
    try {
      created = z.object({ thread: z.object({ id: z.string() }) }).parse(
        await engine.call({
          method: "thread/start",
          params: {
            cwd: input.cwd,
            ...(input.model ? { model: input.model } : {}),
            ...(projectId ? { projectId } : {}),
          },
        }),
      );
    } catch (error) {
      await engine.close();
      throw error;
    }
    const nativeId = created.thread.id,
      sessionId = `codex:${nativeId}`;
    this.owned.set(nativeId, engine);
    let result: Result;
    try {
      if (input.title)
        await engine.call({
          method: "thread/name/set",
          params: { threadId: nativeId, name: input.title },
        });
      result = {
        ...(await this.send({ session_id: sessionId, prompt: input.prompt })),
        created: true,
      };
    } catch (error) {
      result = {
        ...failure({ error, sessionId }),
        created: true,
        instruction:
          "Session exists. Inspect it before sending again; do not repeat creation.",
      };
    }
    await this.refresh({ result, nativeId });
    return result;
  }
  async send(input: SendInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id);
    return this.serialize(nativeId, () => this.sendTurn(input));
  }
  private async sendTurn(input: SendInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id);
    const row = this.store.get(input.session_id);
    if (row.archived) throw new Error("Unarchive the session before sending");
    if (!this.owned.has(nativeId)) {
      try {
        const desktop = await this.openDesktop();
        try {
          const transcript = await this.store.read({
            session_id: input.session_id,
            limit: 1,
          });
          const response = await desktop.send({
            nativeId,
            prompt: input.prompt,
            cwd: row.cwd,
            active: transcript.status === "active",
          });
          const receipt = z
            .object({
              result: z
                .object({
                  turnId: z.string().optional(),
                  turn: z.object({ id: z.string() }).optional(),
                })
                .loose(),
            })
            .parse(response.result).result;
          return {
            session_id: input.session_id,
            status: "accepted",
            turn_id: receipt.turnId ?? receipt.turn?.id,
            transport: "codex_desktop_ipc",
          };
        } finally {
          desktop.close();
        }
      } catch (error) {
        if (
          !(error instanceof DesktopUnavailableError) &&
          !(
            error instanceof DesktopRejection &&
            error.reason === "no-client-found"
          )
        )
          throw error;
      }
      const engine = this.newTurnEngine();
      try {
        await engine.call({
          method: "thread/resume",
          params: { threadId: nativeId, excludeTurns: true },
        });
        this.owned.set(nativeId, engine);
      } catch (error) {
        await engine.close();
        throw error;
      }
    }
    const transcript = await this.store.read({
      session_id: input.session_id,
      limit: 1,
    });
    const activeTurnId = this.turnStates.has(nativeId)
      ? this.turnStates.get(nativeId)
      : transcript.status === "active"
        ? transcript.turn_id
        : null;
    const active = Boolean(activeTurnId);
    if (
      !this.turnStates.has(nativeId) &&
      transcript.status === "active" &&
      !activeTurnId
    )
      throw new OperationError(
        "TURN_STATE_UNAVAILABLE",
        "The current turn ID is unavailable. Read the session again before sending; no message was sent.",
      );
    const version = this.turnVersions.get(nativeId) ?? 0;
    const response = await this.owned.get(nativeId)!.call({
      method: active ? "turn/steer" : "turn/start",
      params: {
        threadId: nativeId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        ...(active ? { expectedTurnId: activeTurnId } : {}),
      },
    });
    const turnId = active
      ? activeTurnId
      : z.object({ turn: z.object({ id: z.string() }) }).parse(response).turn
          .id;
    if ((this.turnVersions.get(nativeId) ?? 0) === version)
      this.turnStates.set(nativeId, turnId ?? null);
    return {
      session_id: input.session_id,
      status: "accepted",
      turn_id: turnId,
      transport: this.owned.get(nativeId)?.transport ?? "codex_app_server",
    };
  }
  async update(input: UpdateInput): Promise<Result> {
    return this.serialize(parseSessionId(input.session_id).nativeId, () =>
      this.updateSession(input),
    );
  }
  private async updateSession(input: UpdateInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id);
    const applied: string[] = [],
      result: Result = {
        session_id: input.session_id,
        status: "updated",
        applied,
      };
    try {
      if (input.title !== undefined) {
        await (this.owned.get(nativeId) ?? this.engine).call({
          method: "thread/name/set",
          params: { threadId: nativeId, name: input.title },
        });
        applied.push("title");
        await this.refresh({ result, nativeId });
      }
      if (input.archived !== undefined) {
        await (this.owned.get(nativeId) ?? this.engine).call({
          method: input.archived ? "thread/archive" : "thread/unarchive",
          params: { threadId: nativeId },
        });
        await this.owned.get(nativeId)?.close();
        this.owned.delete(nativeId);
        applied.push("archived");
        await this.refresh({ result, nativeId, archived: input.archived });
      }
      return result;
    } catch (error) {
      return {
        ...result,
        ...failure({ error, sessionId: input.session_id, applied }),
      };
    }
  }
  async delete(input: DeleteInput): Promise<Result> {
    return this.serialize(parseSessionId(input.session_id).nativeId, () =>
      this.deleteSession(input),
    );
  }
  private async deleteSession(input: DeleteInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id);
    await (this.owned.get(nativeId) ?? this.engine).call({
      method: "thread/delete",
      params: { threadId: nativeId },
    });
    await this.owned.get(nativeId)?.close();
    this.owned.delete(nativeId);
    const result: Result = { session_id: input.session_id, status: "deleted" };
    try {
      if (this.store instanceof CodexStore) this.store.forget(input.session_id);
    } catch {
      result.warning = "Session deleted; local search cache cleanup failed";
    }
    await this.refresh({ result, nativeId, archived: true });
    return result;
  }
  private newTurnEngine() {
    const activeTurns = new Set<string>();
    const threadIds = new Set<string>();
    const engine = this.createEngine((method, params) => {
      const parsed = z
        .object({ threadId: z.string(), turn: z.object({ id: z.string() }) })
        .safeParse(params);
      if (!parsed.success) return;
      const { turn, threadId } = parsed.data;
      if (method !== "turn/started" && method !== "turn/completed") return;
      this.turnVersions.set(
        threadId,
        (this.turnVersions.get(threadId) ?? 0) + 1,
      );
      threadIds.add(threadId);
      if (method === "turn/started") {
        activeTurns.add(turn.id);
        this.turnStates.set(threadId, turn.id);
      }
      if (method !== "turn/completed") return;
      activeTurns.delete(turn.id);
      if (this.turnStates.get(threadId) === turn.id)
        this.turnStates.set(threadId, null);
      const ownerId = [...this.owned].find(
        ([, value]) => value === engine,
      )?.[0];
      if (!ownerId) return;
      void this.serialize(ownerId, async () => {
        if (this.owned.get(ownerId) !== engine || activeTurns.size > 0) return;
        for (const threadId of threadIds) {
          const terminals = z.object({ data: z.array(z.unknown()) }).parse(
            await engine.call({
              method: "thread/backgroundTerminals/list",
              params: { threadId },
            }),
          );
          // A completed answer must not terminate a server the task left running.
          if (terminals.data.length > 0) return;
        }
        if (activeTurns.size > 0) return;
        await engine.close();
        this.owned.delete(ownerId);
        for (const threadId of threadIds) {
          this.turnStates.delete(threadId);
          this.turnVersions.delete(threadId);
        }
        await this.refresh({ nativeId: ownerId, result: {} });
      }).catch((error) =>
        console.error("Codex ownership release failed:", errorMessage(error)),
      );
    });
    return engine;
  }
  private serialize<T>(nativeId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(nativeId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.queues.set(nativeId, next);
    void next
      .finally(() => {
        if (this.queues.get(nativeId) === next) this.queues.delete(nativeId);
      })
      .catch(() => {});
    return next;
  }
  private async refresh({
    result,
    nativeId,
    archived,
  }: {
    result: Result;
    nativeId: string;
    archived?: boolean;
  }) {
    try {
      const desktop = await this.openDesktop();
      try {
        if (archived !== undefined)
          desktop.broadcast({
            method: archived ? "thread-archived" : "thread-unarchived",
            version: archived ? 2 : 1,
            params: { hostId: "local", conversationId: nativeId },
          });
        desktop.broadcast({
          method: "query-cache-invalidate",
          params: { queryKey: [] },
        });
      } finally {
        desktop.close();
      }
    } catch (error) {
      const warnings = z.array(z.unknown()).parse(result.warnings ?? []);
      result.warnings = [
        ...warnings,
        {
          code: "DESKTOP_REFRESH_FAILED",
          message: errorMessage(error),
          instruction:
            "Operation result is unchanged. Desktop may need a refresh.",
        },
      ];
    }
  }
  private async findProject(cwd: string) {
    const common = await gitCommonDirectory(cwd),
      matches: { score: number; id: string }[] = [];
    let cursor: string | null = null;
    do {
      const page = projectsSchema.parse(
        await this.engine.call({
          method: "project/list",
          params: { limit: 100, cursor },
        }),
      );
      for (const project of page.data)
        for (const root of project.roots) {
          const rootPath = resolve(root.path),
            child = relative(rootPath, cwd);
          if (!child || (!child.startsWith("..") && !isAbsolute(child)))
            matches.push({ score: rootPath.length, id: project.id });
          else if (common && common === (await gitCommonDirectory(rootPath)))
            matches.push({ score: 0, id: project.id });
        }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    matches.sort((left, right) => right.score - left.score);
    const first = matches[0];
    if (!first) return null;
    if (
      matches.some(
        (match) => match.score === first.score && match.id !== first.id,
      )
    )
      throw new Error(
        "Directory matches multiple saved projects; choose a more specific directory",
      );
    return first.id;
  }
  close() {
    if (this.store instanceof CodexStore) this.store.close();
    void this.engineInstance?.close();
    for (const engine of this.owned.values()) void engine.close();
  }
}
async function gitCommonDirectory(cwd: string) {
  try {
    return (
      await executeFile(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 5_000 },
      )
    ).stdout.trim();
  } catch {
    return null;
  }
}

function sharedDaemonSocket(): string | undefined {
  let preferences: unknown;
  try {
    preferences = JSON.parse(
      readFileSync(join(stateDirectory, "preferences.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parsed = z
    .object({ codex_shared_daemon: z.boolean().optional() })
    .parse(preferences);
  return parsed.codex_shared_daemon
    ? join(codexHome, "app-server-control", "app-server-control.sock")
    : undefined;
}
