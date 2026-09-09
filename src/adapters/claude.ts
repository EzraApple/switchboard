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
import { failure } from "../errors.js";
import { legacyStateDirectory, stateDirectory } from "../config.js";
import { readJson, writeJson } from "../files.js";
import { ClaudeAPI } from "./claude-api.js";
import { ClaudeWorkers } from "./claude-workers.js";

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
  private readonly api = new ClaudeAPI();
  private readonly workers = new ClaudeWorkers();
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
  async search(input: SearchInput) {
    const sessions: Summary[] = [];
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
          (row.status === "archived") === input.archived &&
          row.title.toLowerCase().includes(input.query.toLowerCase())
        )
          sessions.push(summarize(row));
      cursor = page.next_cursor ?? undefined;
      if (!cursor || sessions.length >= input.limit) break;
    }
    return sessions;
  }
  async read(input: ReadInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id),
      row = await this.getSession(nativeId);
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
      ...summarize(row),
      cwd: (await this.getDirectories())[nativeId],
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
        ...(await this.send({ session_id: sessionId, prompt: input.prompt })),
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
  async send(input: SendInput): Promise<Result> {
    const { nativeId } = parseSessionId(input.session_id),
      row = await this.getSession(nativeId);
    if (row.status === "archived")
      throw new Error("Unarchive the session before sending");
    const cwd = (await this.getDirectories())[nativeId];
    if (
      row.connection_status === "disconnected" &&
      cwd &&
      row.worker_status !== "WORKER_STATUS_UNSPECIFIED"
    )
      await this.workers.resume({ cwd, nativeId });
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
                content: [{ type: "text", text: input.prompt }],
              },
            },
          },
        ],
      },
    });
    return {
      session_id: input.session_id,
      status: "accepted",
      event_id: eventId,
      transport: "claude_remote_control",
      receipt,
    };
  }
  async update(input: UpdateInput): Promise<Result> {
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
