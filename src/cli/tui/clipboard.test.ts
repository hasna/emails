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

  it("prefers OSC52 over SSH pbcopy in a remote TTY session (forwarded to the user's terminal)", () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = copyTextToClipboard("hello clipboard", {
      env: { SSH_CLIENT: "100.100.226.69 54111 22" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: ({ cmd }) => {
        calls.push(cmd.join(" "));
        return { exitCode: 0 }; // even if a local/ssh command WOULD succeed, OSC52 wins first
      },
    });

    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(writes.join("")).toContain("]52;c;");
    expect(calls).toEqual([]); // no reverse-ssh / local clipboard command attempted
  });

  it("regression: over SSH, never copies to the REMOTE host's clipboard (wrong machine)", () => {
    // Running the UI on a remote mac over SSH: previously `pbcopy` ran on the REMOTE mac
    // and set ITS clipboard (useless to the user on their own machine). OSC52 must win.
    const calls: string[] = [];
    const writes: string[] = [];
    const result = copyTextToClipboard("https://has.na/a/xyz", {
      env: { SSH_CONNECTION: "100.100.226.69 54111 100.85.234.92 22" },
      platform: "darwin",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: ({ cmd }) => {
        calls.push(cmd.join(" "));
        return { exitCode: 0 }; // pbcopy on the remote mac WOULD succeed — must not be used
      },
    });

    expect(result.method).toMatch(/^osc52/);
    expect(calls).not.toContain("pbcopy");
    expect(writes.join("")).toContain("]52;c;");
  });

  it("falls back to SSH pbcopy when OSC52 is disabled", () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = copyTextToClipboard("hello clipboard", {
      env: { SSH_CLIENT: "100.100.226.69 54111 22", EMAILS_TUI_CLIPBOARD_OSC52: "never" },
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

  it("prefers OSC52 first in a remote async TTY session", async () => {
    const calls: string[] = [];
    const writes: string[] = [];
    const result = await copyTextToClipboardAsync("hello async", {
      env: { SSH_TTY: "/dev/pts/3", SSH_CONNECTION: "100.100.226.69 54111 100.85.234.92 22" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: () => ({ exitCode: 1, stdout: "" }),
      spawnAsync: async ({ cmd }) => {
        calls.push(cmd.join(" "));
        return { exitCode: 0 };
      },
    });

    expect(result).toEqual({ ok: true, method: "osc52" });
    expect(writes.join("")).toContain("]52;c;");
    expect(calls).toEqual([]);
  });

  it("bounds async SSH clipboard attempts and emits no escape when OSC52 is disabled", async () => {
    const calls: Array<{ cmd: string; timeoutMs: number | undefined }> = [];
    const writes: string[] = [];
    const result = await copyTextToClipboardAsync("hello async", {
      env: { SSH_CLIENT: "100.100.226.69 54111 22", EMAILS_TUI_CLIPBOARD_OSC52: "never" },
      platform: "linux",
      stdoutIsTTY: true,
      writeStdout: (value) => writes.push(value),
      spawnSync: () => ({ exitCode: 1, stdout: "" }),
      spawnAsync: async ({ cmd, timeoutMs }) => {
        calls.push({ cmd: cmd.join(" "), timeoutMs });
        return { exitCode: 1 };
      },
    });

    expect(result.ok).toBe(false);
    expect(calls[0]).toEqual({
      cmd: "ssh -o BatchMode=yes -o ConnectTimeout=1 -o LogLevel=ERROR 100.100.226.69 pbcopy",
      timeoutMs: 1500,
    });
    expect(writes.join("")).not.toContain("]52;c;");
  });

  it("copies through the attached tmux client SSH environment when the pane env is stale", () => {
    // With OSC52 disabled, the discovered SSH host (from the stale tmux pane env) is still
    // used for the reverse-ssh pbcopy route.
    const calls: string[] = [];
    const result = copyTextToClipboard("hello from tmux", {
      env: { TMUX: "/tmp/tmux-1000/default,1,0", EMAILS_TUI_CLIPBOARD_OSC52: "never" },
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
