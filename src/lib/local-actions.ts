import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type LocalOpenTargetKind = "web" | "file";

export interface LocalOpenTarget {
  kind: LocalOpenTargetKind;
  value: string;
  display: string;
  file_url?: string;
}

export interface LocalOpenResult {
  ok: boolean;
  target?: LocalOpenTarget;
  method?: string;
  error?: string;
}

export interface LocalActionRuntime {
  platform: NodeJS.Platform;
  fileExists(path: string): boolean;
  spawnSync(cmd: string[]): { exitCode: number | null };
}

function defaultRuntime(): LocalActionRuntime {
  return {
    platform: process.platform,
    fileExists: existsSync,
    spawnSync: (cmd) => Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" }),
  };
}

export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

export function normalizeWebUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return null;
    parsed.protocol = protocol;
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function localFileUrl(path: string): string {
  const expanded = expandHomePath(path);
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  return pathToFileURL(absolute).href;
}

export function describeLocalOpenTarget(value: string, runtime: LocalActionRuntime = defaultRuntime()): LocalOpenTarget | null {
  const web = normalizeWebUrl(value);
  if (web) return { kind: "web", value: web, display: web };

  const expanded = expandHomePath(value.trim());
  if (!expanded || expanded.startsWith("s3://")) return null;
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  if (!runtime.fileExists(absolute)) return null;
  return {
    kind: "file",
    value: absolute,
    display: absolute,
    file_url: localFileUrl(absolute),
  };
}

function openCommand(target: LocalOpenTarget, runtime: LocalActionRuntime): { method: string; cmd: string[] } {
  const value = target.value;
  if (runtime.platform === "darwin") return { method: "open", cmd: ["open", value] };
  if (runtime.platform === "win32") return { method: "start", cmd: ["cmd", "/c", "start", "", value] };
  return { method: "xdg-open", cmd: ["xdg-open", value] };
}

export function openLocalTarget(value: string, runtime: LocalActionRuntime = defaultRuntime()): LocalOpenResult {
  const target = describeLocalOpenTarget(value, runtime);
  if (!target) {
    return { ok: false, error: "Target is not an openable http(s) URL or existing local file." };
  }
  const { method, cmd } = openCommand(target, runtime);
  try {
    const result = runtime.spawnSync(cmd);
    if (result.exitCode === 0) return { ok: true, target, method };
    return { ok: false, target, method, error: `${method} exited with code ${result.exitCode ?? "unknown"}` };
  } catch (error) {
    return { ok: false, target, method, error: error instanceof Error ? error.message : String(error) };
  }
}
