import {
  schemas,
  parseSessionId,
  type Adapter,
  type Harness,
  type Operation,
  type Result,
} from "./contracts.js";
import { errorMessage, failure } from "./errors.js";
import { compareSessions } from "./search.js";
import { workspaceDirectory } from "./files.js";

export class SessionManager {
  constructor(private readonly adapters: Record<Harness, Adapter>) {}
  async execute({
    operation,
    arguments: arguments_,
  }: {
    operation: Operation;
    arguments: unknown;
  }): Promise<Result> {
    try {
      switch (operation) {
        case "search_sessions": {
          const input = schemas.search_sessions.parse(arguments_);
          const harnesses: Harness[] = input.harness
            ? [input.harness]
            : ["codex", "claude"];
          const errors: Record<string, string> = {};
          const warnings: string[] = [];
          const pages = await Promise.all(
            harnesses.map(async (harness) => {
              try {
                const page = await this.adapters[harness].search(input);
                if (Array.isArray(page)) return page;
                warnings.push(
                  ...page.warnings.map((warning) => `${harness}: ${warning}`),
                );
                return page.sessions;
              } catch (error) {
                if (input.harness) throw error;
                errors[harness] = errorMessage(error);
                return [];
              }
            }),
          );
          const sessions = pages
            .flat()
            .sort(compareSessions)
            .slice(0, input.limit);
          return {
            sessions,
            errors,
            warnings,
            search_scope:
              "Titles, directories, and visible user/assistant text; check warnings for unavailable or incomplete sources",
          };
        }
        case "create_session": {
          const input = schemas.create_session.parse(arguments_);
          return await this.adapters[input.harness].create({
            ...input,
            cwd: await workspaceDirectory(input.cwd),
          });
        }
        case "read_session": {
          const input = schemas.read_session.parse(arguments_);
          return await this.adapters[
            parseSessionId(input.session_id).harness
          ].read(input);
        }
        case "send_message": {
          const input = schemas.send_message.parse(arguments_);
          return await this.adapters[
            parseSessionId(input.session_id).harness
          ].send(input);
        }
        case "update_session": {
          const input = schemas.update_session.parse(arguments_);
          return await this.adapters[
            parseSessionId(input.session_id).harness
          ].update(input);
        }
        case "delete_session": {
          const input = schemas.delete_session.parse(arguments_);
          return await this.adapters[
            parseSessionId(input.session_id).harness
          ].delete(input);
        }
      }
    } catch (error) {
      const input = schemas.delete_session
        .pick({ session_id: true })
        .safeParse(arguments_);
      return failure({
        error,
        sessionId: input.success ? input.data.session_id : undefined,
      });
    }
  }
  close() {
    for (const adapter of Object.values(this.adapters)) adapter.close();
  }
}
