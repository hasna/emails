export interface ClipboardResult {
  ok: boolean;
  method?: string;
  error?: string;
}

interface SpawnResult {
  exitCode: number | null;
}

interface ClipboardRuntime {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
  writeStdout: (value: string) => void;
  spawnSync: (options: { cmd: string[]; stdin: Uint8Array; stdout: "ignore"; stderr: "ignore" }) => SpawnResult;
}

const OSC52_MAX_BYTES = 90_000;
const DEFAULT_SSH_TIMEOUT_SECONDS = "2";

function defaultRuntime(): ClipboardRuntime {
  return {
    env: process.env,
    platform: process.platform,
    stdoutIsTTY: process.stdout.isTTY,
    writeStdout: (value) => {
      process.stdout.write(value);
    },
    spawnSync: (options) => Bun.spawnSync(options),
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

function splitHostList(value: string | undefined): string[] {
  return (value ?? "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

export function sshClipboardHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = [
    env["EMAILS_TUI_CLIPBOARD_HOST"],
    ...splitHostList(env["EMAILS_TUI_CLIPBOARD_SSH_HOSTS"]),
    env["SSH_CLIENT"]?.split(/\s+/)[0],
    env["SSH_CONNECTION"]?.split(/\s+/)[0],
  ].filter((host): host is string => !!host);
  return [...new Set(hosts)];
}

function sshClipboardCommands(env: NodeJS.ProcessEnv): string[][] {
  const timeout = env["EMAILS_TUI_CLIPBOARD_SSH_TIMEOUT"] || DEFAULT_SSH_TIMEOUT_SECONDS;
  return sshClipboardHosts(env).map((host) => [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${timeout}`,
    "-o", "LogLevel=ERROR",
    host,
    "pbcopy",
  ]);
}

export function clipboardCommands(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[][] {
  const commands: string[][] = [];
  const configured = env["EMAILS_TUI_CLIPBOARD_COMMAND"]?.trim();
  if (configured) commands.push(configured.split(/\s+/));
  if (platform === "darwin") commands.push(["pbcopy"]);
  commands.push(...sshClipboardCommands(env));
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

export function copyTextToClipboard(text: string, runtime: ClipboardRuntime = defaultRuntime()): ClipboardResult {
  if (!text.trim()) return { ok: false, error: "nothing to copy" };
  if (runtime.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"] === "1") return { ok: true, method: "dry-run" };

  for (const cmd of clipboardCommands(runtime.platform, runtime.env)) {
    if (runClipboardCommand(runtime, cmd, text)) return { ok: true, method: commandMethod(cmd) };
  }

  const tmux = copyToTmuxBuffer(text, runtime);
  if (tmux) return tmux;

  const osc52 = copyWithOsc52(text, runtime);
  if (osc52) return osc52;

  return { ok: false, error: "no supported clipboard route found" };
}
