import { Database } from "bun:sqlite";

/** Explicit SQLite injection takes precedence over process-wide mode routing. */
export function hasDatabaseArgument(args: readonly unknown[]): boolean {
  return args.some((value) => value instanceof Database);
}
