import { homedir } from "node:os";
import { join } from "node:path";
export const stateDirectory =
  process.env.SWITCHBOARD_STATE_DIR ??
  join(homedir(), ".local/state/switchboard");
export const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const legacyStateDirectory = join(
  homedir(),
  ".local/state/session-bridge",
);
export const version = "0.1.0";
