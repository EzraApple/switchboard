import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const helper = join(
  dirname(require.resolve("node-pty/package.json")),
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
// node-pty 1.1.0's macOS prebuild ships its required executable without execute bits.
if (existsSync(helper)) chmodSync(helper, 0o755);
