import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  schemas,
  descriptions,
  type Operation,
  type Result,
} from "./contracts.js";
import { failure } from "./errors.js";
import { version } from "./config.js";

export async function serveMCP(
  execute: (request: {
    operation: Operation;
    arguments: unknown;
  }) => Promise<Result>,
) {
  const server = new Server(
    { name: "switchboard", version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(schemas).map(([name, schema]) => ({
      name,
      description: descriptions[name as Operation],
      inputSchema: z.toJSONSchema(schema, {
        target: "draft-7",
      }) as Tool["inputSchema"],
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let result: Result;
    try {
      if (!Object.hasOwn(schemas, request.params.name))
        throw new Error("Unknown operation");
      const operation = request.params.name as Operation;
      const arguments_ = schemas[operation].parse(
        request.params.arguments ?? {},
      );
      result = await execute({ operation, arguments: arguments_ });
    } catch (error) {
      result = failure({ error });
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
      isError: result.status === "failed" || result.status === "partial",
    };
  });
  await server.connect(new StdioServerTransport());
}
