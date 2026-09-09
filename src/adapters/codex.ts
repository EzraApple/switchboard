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
import { errorMessage, failure } from "../errors.js";
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
type Engine = Pick<CodexEngine, "call" | "close">;
type Desktop = Pick<CodexIPC, "send" | "broadcast" | "close">;
export class CodexAdapter implements Adapter {
  private engineInstance: Engine | undefined;
  private readonly owned = new Set<string>();
  private readonly store: Pick<CodexStore, "search" | "get" | "read">;
  private readonly openDesktop: () => Promise<Desktop>;
  constructor(
    options: {
      engine?: Engine;
      store?: Pick<CodexStore, "search" | "get" | "read">;
      openDesktop?: () => Promise<Desktop>;
    } = {},
  ) {
    this.engineInstance = options.engine;
    this.store = options.store ?? new CodexStore();
    this.openDesktop = options.openDesktop ?? (() => CodexIPC.open());
  }
  private get engine() {
    return (this.engineInstance ??= new CodexEngine());
  }
  async search(input: SearchInput) {
    return this.store.search(input);
  }
  async read(input: ReadInput) {
    return this.store.read(input);
  }
  async create(input: CreateInput): Promise<Result> {
    const projectId = await this.findProject(input.cwd);
    const created = z.object({ thread: z.object({ id: z.string() }) }).parse(
      await this.engine.call({
        method: "thread/start",
        params: {
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(projectId ? { projectId } : {}),
        },
      }),
    );
    const nativeId = created.thread.id,
      sessionId = `codex:${nativeId}`;
    this.owned.add(nativeId);
    let result: Result;
    try {
      if (input.title)
        await this.engine.call({
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
      await this.engine.call({
        method: "thread/resume",
        params: { threadId: nativeId, excludeTurns: true },
      });
      this.owned.add(nativeId);
    }
    const transcript = await this.store.read({
      session_id: input.session_id,
      limit: 1,
    });
    const active = transcript.status === "active";
    const response = await this.engine.call({
      method: active ? "turn/steer" : "turn/start",
      params: {
        threadId: nativeId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        ...(active ? { expectedTurnId: transcript.turn_id } : {}),
      },
    });
    const turnId = active
      ? transcript.turn_id
      : z.object({ turn: z.object({ id: z.string() }) }).parse(response).turn
          .id;
    return {
      session_id: input.session_id,
      status: "accepted",
      turn_id: turnId,
      transport: "codex_app_server",
    };
  }
  async update(input: UpdateInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id);
    const applied: string[] = [],
      result: Result = {
        session_id: input.session_id,
        status: "updated",
        applied,
      };
    try {
      if (input.title !== undefined) {
        await this.engine.call({
          method: "thread/name/set",
          params: { threadId: nativeId, name: input.title },
        });
        applied.push("title");
        await this.refresh({ result, nativeId });
      }
      if (input.archived !== undefined) {
        await this.engine.call({
          method: input.archived ? "thread/archive" : "thread/unarchive",
          params: { threadId: nativeId },
        });
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
    const { nativeId } = parseSessionId(input.session_id);
    await this.engine.call({
      method: "thread/delete",
      params: { threadId: nativeId },
    });
    this.owned.delete(nativeId);
    const result: Result = { session_id: input.session_id, status: "deleted" };
    await this.refresh({ result, nativeId, archived: true });
    return result;
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
    this.engineInstance?.close();
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
