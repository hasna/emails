export interface ClipboardResult {
  ok: boolean;
  method?: string;
  error?: string;
}

const OSC52_MAX_BYTES = 90_000;

function clippedForOsc52(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= OSC52_MAX_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, OSC52_MAX_BYTES));
}

function copyWithOsc52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  const encoded = Buffer.from(clippedForOsc52(text)).toString("base64");
  process.stdout.write(`\x1b]52;c;${encoded}\x07`);
  return true;
}

function runClipboardCommand(cmd: string[], text: string): boolean {
  try {
    const result = Bun.spawnSync({
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

function clipboardCommands(): string[][] {
  if (process.platform === "darwin") return [["pbcopy"]];
  if (process.platform === "win32") return [["clip.exe"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
    ["termux-clipboard-set"],
  ];
}

export function copyTextToClipboard(text: string): ClipboardResult {
  if (!text.trim()) return { ok: false, error: "nothing to copy" };
  if (process.env["EMAILS_TUI_CLIPBOARD_DRY_RUN"] === "1") return { ok: true, method: "dry-run" };
  if (copyWithOsc52(text)) return { ok: true, method: "osc52" };

  for (const cmd of clipboardCommands()) {
    if (runClipboardCommand(cmd, text)) return { ok: true, method: cmd[0] };
  }

  return { ok: false, error: "no supported clipboard command found" };
}
