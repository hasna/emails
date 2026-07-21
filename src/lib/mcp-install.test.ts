import { describe, expect, it } from "bun:test";
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "./mcp-install.js";

describe("MCP install metadata", () => {
  it("registers Claude Code with an explicitly stdio-bound server command", () => {
    expect(getClaudeMcpInstallCommand()).toEqual({
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "mailery", "--", "mailery-mcp", "--stdio"],
      shell: "claude mcp add --transport stdio --scope user mailery -- mailery-mcp --stdio",
    });
  });

  it("builds the stable Claude Code removal command", () => {
    expect(getClaudeMcpRemoveCommand()).toEqual({
      command: "claude",
      args: ["mcp", "remove", "mailery"],
      shell: "claude mcp remove mailery",
    });
  });

  it("registers Codex with an explicitly stdio-bound server command", () => {
    expect(getCodexMcpConfig()).toBe(`[mcp_servers.mailery]
command = "mailery-mcp"
args = ["--stdio"]
`);
  });

  it("registers Gemini with an explicitly stdio-bound server command", () => {
    expect(getGeminiMcpConfig()).toEqual({ mcpServers: { mailery: { command: "mailery-mcp", args: ["--stdio"] } } });
  });
});
