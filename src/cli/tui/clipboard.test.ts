import { describe, expect, it } from "bun:test";
import { clipboardCommands, copyTextToClipboard, copyTextToClipboardAsync, sshClipboardHosts } from "./clipboard.js";

describe("tui clipboard", () => {
  it("detects explicit and SSH client clipboard hosts", () => {
    expect(sshClipboardHosts({
      EMAILS_TUI_CLIPBOARD_HOST: "apple03",
      EMAILS_TUI_CLIPBOARD_SSH_HOSTS: "apple01, apple06",
      SSH_CLIENT: "100.100.226.69 54111 22",
      SSH_CONNECTION: "100.100.226.69 54111 100.85.234.92 22",
      MOSH_CLIENT_IP: "100.100.226.70",
    })).toEqual(["apple03", "apple01", "apple06", "100.100.226.69", "100.100.226.70"]);
  });

  it("tries configured, local, and SSH clipboard commands before terminal escapes", () => {
    const commands = clipboardCommands("linux", {
      EMAILS_TUI_CLIPBOARD_COMMAND: "custom-copy --stdin",
      SSH_CLIENT: "100.100.226.69 54111 22",
    }).map((cmd) => cmd.join(" "));

    expect(commands.slice(0, 4)).toEqual([
      "custom-copy --stdin",
      "ssh -o BatchMode=yes -o ConnectTimeout=1 -o LogLevel=ERROR 100.100.226.69 pbcopy",
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
    expect(calls[0]).toBe("ssh -o BatchMode=yes -o ConnectTimeout=1 -o LogLevel=ERROR 100.100.226.69 pbcopy");
    expect(writes).toEqual([]);
  });

  it("bounds async SSH clipboard attempts and falls back to OSC52", async () => {
    const calls: Array<{ cmd: string; timeoutMs: number | undefined }> = [];
    const writes: string[] = [];
    const result = await copyTextToClipboardAsync("hello async", {
      env: { SSH_CLIENT: "100.100.226.69 54111 22" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: () => ({ exitCode: 1, stdout: "" }),
      spawnAsync: async ({ cmd, timeoutMs }) => {
        calls.push({ cmd: cmd.join(" "), timeoutMs });
        return { exitCode: 1 };
      },
    });

    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(calls[0]).toEqual({
      cmd: "ssh -o BatchMode=yes -o ConnectTimeout=1 -o LogLevel=ERROR 100.100.226.69 pbcopy",
      timeoutMs: 1500,
    });
    expect(writes.join("")).toContain("]52;c;");
  });

  it("copies through the attached tmux client SSH environment when the pane env is stale", () => {
    const calls: string[] = [];
    const result = copyTextToClipboard("hello from tmux", {
      env: { TMUX: "/tmp/tmux-1000/default,1,0" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: () => {},
      readFile: (path) => path === "/proc/123/environ" ? "SSH_CLIENT=100.100.226.69 54111 22\0" : null,
      spawnSync: ({ cmd, stdout }) => {
        calls.push(cmd.join(" "));
        if (stdout === "pipe") {
          if (cmd.join(" ") === "tmux display-message -p #{client_pid}") return { exitCode: 0, stdout: "123\n" };
          if (cmd.join(" ") === "tmux list-clients -F #{client_pid}") return { exitCode: 0, stdout: "123\n" };
          return { exitCode: 1, stdout: "" };
        }
        return { exitCode: cmd[0] === "ssh" ? 0 : 1 };
      },
    });

    expect(result).toEqual({ ok: true, method: "ssh-pbcopy:100.100.226.69" });
    expect(calls).toContain("ssh -o BatchMode=yes -o ConnectTimeout=1 -o LogLevel=ERROR 100.100.226.69 pbcopy");
  });
});
