import { Database } from "bun:sqlite";

let explicitDatabaseRouteDepth = 0;

/** Explicit SQLite injection takes precedence over process-wide mode routing. */
export function hasDatabaseArgument(args: readonly unknown[]): boolean {
  return args.some((value) => value instanceof Database);
}

/** Run a synchronous repository call without allowing nested HTTP rerouting. */
export function withExplicitDatabaseRoute<T>(args: readonly unknown[], run: () => T): T {
  if (!hasDatabaseArgument(args)) return run();
  explicitDatabaseRouteDepth += 1;
  try {
    return run();
  } finally {
    explicitDatabaseRouteDepth -= 1;
  }
}

export function isExplicitDatabaseRoute(): boolean {
  return explicitDatabaseRouteDepth > 0;
}
