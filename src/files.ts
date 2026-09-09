import {
  mkdir,
  readFile,
  rename,
  writeFile,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export async function readJson<T>({
  path,
  schema,
  fallback,
}: {
  path: string;
  schema: z.ZodType<T>;
  fallback: T;
}): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return fallback;
    throw error;
  }
}
export function isErrno(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
export async function writeJson({
  path,
  value,
}: {
  path: string;
  value: unknown;
}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}
export async function workspaceDirectory(path: string) {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path;
  if (!isAbsolute(expanded))
    throw new Error("cwd must be an absolute directory");
  const directory = await realpath(expanded);
  if (!(await stat(directory)).isDirectory())
    throw new Error("cwd must be a directory");
  return directory;
}
