import { describe, expect, it } from "bun:test";
import { clipboardCommands, copyTextToClipboard, sshClipboardHosts } from "./clipboard.js";

describe("tui clipboard", () => {
  it("detects explicit and SSH client clipboard hosts", () => {
    expect(sshClipboardHosts({
      EMAILS_TUI_CLIPBOARD_HOST: "apple03",
      EMAILS_TUI_CLIPBOARD_SSH_HOSTS: "apple01, apple06",
      SSH_CLIENT: "100.100.226.69 54111 22",
      SSH_CONNECTION: "100.100.226.69 54111 100.85.234.92 22",
    })).toEqual(["apple03", "apple01", "apple06", "100.100.226.69"]);
  });

  it("tries configured, local, and SSH clipboard commands before terminal escapes", () => {
    const commands = clipboardCommands("linux", {
      EMAILS_TUI_CLIPBOARD_COMMAND: "custom-copy --stdin",
      SSH_CLIENT: "100.100.226.69 54111 22",
    }).map((cmd) => cmd.join(" "));

    expect(commands.slice(0, 4)).toEqual([
      "custom-copy --stdin",
      "ssh -o BatchMode=yes -o ConnectTimeout=2 -o LogLevel=ERROR 100.100.226.69 pbcopy",
      "pbcopy",
      "tmux-clipboard-copy",
    ]);
  });

  it("copies through SSH pbcopy before OSC52 when a client host is available", () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = copyTextToClipboard("hello clipboard", {
      env: { SSH_CLIENT: "100.100.226.69 54111 22" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: ({ cmd }) => {
        calls.push(cmd.join(" "));
        return { exitCode: cmd[0] === "ssh" ? 0 : 1 };
      },
    });

    expect(result).toEqual({ ok: true, method: "ssh-pbcopy:100.100.226.69" });
    expect(calls[0]).toBe("ssh -o BatchMode=yes -o ConnectTimeout=2 -o LogLevel=ERROR 100.100.226.69 pbcopy");
    expect(writes).toEqual([]);
  });
});
