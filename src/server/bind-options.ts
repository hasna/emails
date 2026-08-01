import type { ServerStorageBackend } from "./storage-backend.js";

// THE BIND DEFAULTS FOLLOW THE SERVER'S INTERNAL STORE, and the type that used to name a
// deployment mode here is deleted rather than aliased — an unused alias would keep the
// vocabulary reachable for the next module that imports it.
//
// That the defaults follow the store is not a rename: they encode a security property that
// belongs to the store rather than to any product variant. A PostgreSQL server is reachable
// by other hosts by construction (its database is), so it binds 0.0.0.0:8080 behind the
// operator's own load balancer. A SQLite server holds one operator's private mailbox in a
// file under their home directory, so it binds loopback only, and nothing on the network
// can read it without an explicit `--host` and `EMAILS_ALLOW_REMOTE=1`.

export interface ServerBindOptions {
  host: string;
  port: number;
}

function optionValue(args: string[], name: "--host" | "--port"): string | undefined {
  let value: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      value = next;
      index++;
      continue;
    }

    const prefix = `${name}=`;
    if (arg?.startsWith(prefix)) {
      const inline = arg.slice(prefix.length);
      if (!inline) throw new Error(`${name} requires a value`);
      value = inline;
    }
  }

  return value;
}

function parsePort(raw: string, source: "--port" | "PORT"): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${source} must be an integer between 0 and 65535`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source} must be an integer between 0 and 65535`);
  }
  return port;
}

/** Resolve bind settings with explicit CLI > environment > backend-default precedence. */
export function resolveServerBindOptions(
  args: string[],
  env: Record<string, string | undefined>,
  backend: ServerStorageBackend,
): ServerBindOptions {
  const hostFlag = optionValue(args, "--host");
  const portFlag = optionValue(args, "--port");
  const defaultHost = backend === "postgresql" ? "0.0.0.0" : "127.0.0.1";
  const defaultPort = backend === "postgresql" ? 8080 : 3900;

  const envPort = env["PORT"] || undefined;
  return {
    host: hostFlag ?? env["HOST"] ?? defaultHost,
    port: portFlag !== undefined
      ? parsePort(portFlag, "--port")
      : envPort !== undefined
        ? parsePort(envPort, "PORT")
        : defaultPort,
  };
}
