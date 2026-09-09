#!/usr/bin/env node
import { callDaemon, serveDaemon } from "./daemon.js";
import { serveMCP } from "./mcp.js";
import { schemas, type Operation } from "./contracts.js";
import { failure } from "./errors.js";

const [mode, operation, arguments_] = process.argv.slice(2);
try {
  if (mode === "daemon") await serveDaemon();
  else if (mode === "call") {
    if (!operation || !Object.hasOwn(schemas, operation))
      throw new Error("Usage: switchboard call <operation> <JSON>");
    const result = await callDaemon({
      operation: operation as Operation,
      arguments: JSON.parse(arguments_ ?? "{}"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed" || result.status === "partial")
      process.exitCode = 1;
  } else if (mode === undefined) await serveMCP(callDaemon);
  else throw new Error("Usage: switchboard [call <operation> <JSON>]");
} catch (error) {
  console.error(JSON.stringify(failure({ error })));
  process.exitCode = 1;
}
