import { readFileSync } from "node:fs";

export interface ClipboardResult {
  ok: boolean;
  method?: string;
  error?: string;
}

interface SpawnOptions {
  cmd: string[];
  stdin?: Uint8Array;
  stdout: "ignore" | "pipe";
  stderr: "ignore";
  timeoutMs?: number;
}

interface SpawnResult {
  exitCode: number | null;
  stdout?: Uint8Array | string;
}

interface ClipboardRuntime {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
  writeStdout: (value: string) => void;
  spawnSync: (options: SpawnOptions) => SpawnResult;
  spawnAsync?: (options: SpawnOptions) => Promise<SpawnResult>;
  readFile?: (path: string) => Uint8Array | string | null;
}

const OSC52_MAX_BYTES = 90_000;
const DEFAULT_SSH_TIMEOUT_SECONDS = "1";
const DEFAULT_COMMAND_TIMEOUT_MS = 1500;

function defaultRuntime(): ClipboardRuntime {
  return {
    env: process.env,
    platform: process.platform,
    stdoutIsTTY: process.stdout.isTTY,
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    spawnSync: (options) => Bun.spawnSync(options),
    spawnAsync: async (options) => {
      const proc = Bun.spawn({
        cmd: options.cmd,
        stdin: options.stdin ? "pipe" : "ignore",
        stdout: options.stdout,
        stderr: options.stderr,
      });
      if (options.stdin && proc.stdin) {
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      }
      let timedOut = false;
      const timeout = options.timeoutMs
        ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, options.timeoutMs)
        : null;
      try {
        const [exitCode, stdout] = await Promise.all([
          proc.exited.catch(() => null),
          options.stdout === "pipe" && proc.stdout
            ? new Response(proc.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        return { exitCode: timedOut ? null : exitCode, stdout };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

function clippedForOsc52(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= OSC52_MAX_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, OSC52_MAX_BYTES));
}

function copyWithOsc52(text: string, runtime: ClipboardRuntime): ClipboardResult | null {
  if (!runtime.stdoutIsTTY) return null;
  const encoded = Buffer.from(clippedForOsc52(text)).toString("base64");
  if (runtime.env["TMUX"]) {
    runtime.writeStdout(`\x1bPtmux;\x1b\x1b]52;c;${encoded}\x07\x1b\\`);
    return { ok: true, method: "osc52-tmux" };
  }
  runtime.writeStdout(`\x1b]52;c;${encoded}\x07`);
  return { ok: true, method: "osc52" };
}

function runClipboardCommand(runtime: ClipboardRuntime, cmd: string[], text: string): boolean {
  try {
    const result = runtime.spawnSync({
      cmd,
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function clipboardCommandTimeoutMs(runtime: ClipboardRuntime): number {
  const raw = runtime.env["MAILERY_TUI_CLIPBOARD_COMMAND_TIMEOUT_MS"] || runtime.env["EMAILS_TUI_CLIPBOARD_COMMAND_TIMEOUT_MS"];
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_COMMAND_TIMEOUT_MS;
  return Number.isFinite(parsed) ? Math.max(250, parsed) : DEFAULT_COMMAND_TIMEOUT_MS;
}

async function runClipboardCommandAsync(runtime: ClipboardRuntime, cmd: string[], text: string): Promise<boolean> {
  if (!runtime.spawnAsync) return runClipboardCommand(runtime, cmd, text);
  try {
    const result = await runtime.spawnAsync({
      cmd,
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
      timeoutMs: clipboardCommandTimeoutMs(runtime),
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function commandOutput(runtime: ClipboardRuntime, cmd: string[]): string {
  try {
    const result = runtime.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0 || !result.stdout) return "";
    return typeof result.stdout === "string" ? result.stdout : Buffer.from(result.stdout).toString("utf8");
  } catch {
    return "";
  }
}

function readFileText(runtime: ClipboardRuntime, path: string): string {
  try {
    const content = runtime.readFile?.(path);
    if (!content) return "";
    return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  } catch {
    return "";
  }
}

function splitHostList(value: string | undefined): string[] {
  return (value ?? "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function firstEnvWord(value: string | undefined): string | undefined {
  return value?.split(/\s+/)[0];
}

function parseEnvironmentText(text: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of text.split(/\0|\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

function tmuxClientPids(runtime: ClipboardRuntime): string[] {
  const active = commandOutput(runtime, ["tmux", "display-message", "-p", "#{client_pid}"]);
  const listed = commandOutput(runtime, ["tmux", "list-clients", "-F", "#{client_pid}"]);
  return [...new Set(`${active}\n${listed}`.split(/\s+/).filter((pid) => /^\d+$/.test(pid)))];
}

function tmuxEnvironmentHosts(runtime: ClipboardRuntime): string[] {
  if (!runtime.env["TMUX"]) return [];
  const envParts = [
    commandOutput(runtime, ["tmux", "show-environment", "-g", "SSH_CLIENT"]),
    commandOutput(runtime, ["tmux", "show-environment", "-g", "SSH_CONNECTION"]),
    commandOutput(runtime, ["tmux", "show-environment", "-g", "MOSH_IP"]),
    commandOutput(runtime, ["tmux", "show-environment", "-g", "MOSH_CLIENT_IP"]),
  ];
  for (const pid of tmuxClientPids(runtime)) {
    envParts.push(readFileText(runtime, `/proc/${pid}/environ`));
  }
  return sshClipboardHosts(parseEnvironmentText(envParts.join("\n")));
}

export function sshClipboardHosts(env: NodeJS.ProcessEnv = process.env, discoveredHosts: string[] = []): string[] {
  const explicitHosts = [
    ...splitHostList(env["MAILERY_TUI_CLIPBOARD_HOST"]),
    ...splitHostList(env["MAILERY_TUI_CLIPBOARD_SSH_HOSTS"]),
    ...splitHostList(env["EMAILS_TUI_CLIPBOARD_HOST"]),
    ...splitHostList(env["EMAILS_TUI_CLIPBOARD_SSH_HOSTS"]),
  ];
  const hosts = [
    ...explicitHosts,
    ...discoveredHosts,
    firstEnvWord(env["SSH_CLIENT"]),
    firstEnvWord(env["SSH_CONNECTION"]),
    firstEnvWord(env["MOSH_IP"]),
    firstEnvWord(env["MOSH_CLIENT_IP"]),
    firstEnvWord(env["MOSH_CLIENT_HOST"]),
  ].filter((host): host is string => !!host);
  return [...new Set(hosts)];
}

function sshClipboardCommands(env: NodeJS.ProcessEnv, discoveredHosts: string[] = []): string[][] {
  const timeout = env["MAILERY_TUI_CLIPBOARD_SSH_TIMEOUT"] || env["EMAILS_TUI_CLIPBOARD_SSH_TIMEOUT"] || DEFAULT_SSH_TIMEOUT_SECONDS;
  return sshClipboardHosts(env, discoveredHosts).map((host) => [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${timeout}`,
    "-o", "LogLevel=ERROR",
    host,
    "pbcopy",
  ]);
}

export function clipboardCommands(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, discoveredHosts: string[] = []): string[][] {
  const commands: string[][] = [];
  const configured = (env["MAILERY_TUI_CLIPBOARD_COMMAND"] || env["EMAILS_TUI_CLIPBOARD_COMMAND"])?.trim();
  if (configured) commands.push(configured.split(/\s+/));
  if (platform === "darwin") commands.push(["pbcopy"]);
  commands.push(...sshClipboardCommands(env, discoveredHosts));
  if (platform !== "darwin") commands.push(["pbcopy"]);
  if (platform === "win32") commands.push(["clip.exe"]);
  commands.push(["tmux-clipboard-copy"]);
  return [
    ...commands,
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
    ["termux-clipboard-set"],
  ];
}

function commandMethod(cmd: string[]): string {
  if (cmd[0] === "ssh") return `ssh-pbcopy:${cmd.at(-2) ?? "host"}`;
  return cmd[0] ?? "command";
}

function copyToTmuxBuffer(text: string, runtime: ClipboardRuntime): ClipboardResult | null {
  if (!runtime.env["TMUX"]) return null;
  if (runClipboardCommand(runtime, ["tmux", "load-buffer", "-"], text)) return { ok: true, method: "tmux-buffer" };
  return null;
}

async function copyToTmuxBufferAsync(text: string, runtime: ClipboardRuntime): Promise<ClipboardResult | null> {
  if (!runtime.env["TMUX"]) return null;
  if (await runClipboardCommandAsync(runtime, ["tmux", "load-buffer", "-"], text)) return { ok: true, method: "tmux-buffer" };
  return null;
}

export function copyTextToClipboard(text: string, runtime: ClipboardRuntime = defaultRuntime()): ClipboardResult {
  if (!text.trim()) return { ok: false, error: "nothing to copy" };
  if (runtime.env["MAILERY_TUI_CLIPBOARD_DRY_RUN"] === "1" || runtime.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"] === "1") return { ok: true, method: "dry-run" };

  for (const cmd of clipboardCommands(runtime.platform, runtime.env, tmuxEnvironmentHosts(runtime))) {
    if (runClipboardCommand(runtime, cmd, text)) return { ok: true, method: commandMethod(cmd) };
  }

  const tmux = copyToTmuxBuffer(text, runtime);
  if (tmux) return tmux;

  const osc52 = copyWithOsc52(text, runtime);
  if (osc52) return osc52;

  return { ok: false, error: "no supported clipboard route found" };
}

export async function copyTextToClipboardAsync(text: string, runtime: ClipboardRuntime = defaultRuntime()): Promise<ClipboardResult> {
  if (!text.trim()) return { ok: false, error: "nothing to copy" };
  if (runtime.env["MAILERY_TUI_CLIPBOARD_DRY_RUN"] === "1" || runtime.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"] === "1") return { ok: true, method: "dry-run" };

  const commands = clipboardCommands(runtime.platform, runtime.env, tmuxEnvironmentHosts(runtime));
  for (const cmd of commands) {
    if (await runClipboardCommandAsync(runtime, cmd, text)) return { ok: true, method: commandMethod(cmd) };
  }

  const tmux = await copyToTmuxBufferAsync(text, runtime);
  if (tmux) return tmux;

  const osc52 = copyWithOsc52(text, runtime);
  if (osc52) return osc52;

  return { ok: false, error: "no supported clipboard route found" };
}
