import { describe, expect, it } from "bun:test";
import { getClaudeMcpInstallCommand, getClaudeMcpRemoveCommand, getCodexMcpConfig, getGeminiMcpConfig } from "./mcp-install.js";

describe("MCP install metadata", () => {
  it("builds stable Claude Code install and removal commands", () => {
    expect(getClaudeMcpInstallCommand()).toEqual({
      command: "claude",
      args: ["mcp", "add", "--transport", "stdio", "--scope", "user", "mailery", "--", "mailery-mcp"],
      shell: "claude mcp add --transport stdio --scope user mailery -- mailery-mcp",
    });
    expect(getClaudeMcpRemoveCommand()).toEqual({
      command: "claude",
      args: ["mcp", "remove", "mailery"],
      shell: "claude mcp remove mailery",
    });
  });

  it("builds stable Codex and Gemini snippets", () => {
    expect(getCodexMcpConfig()).toContain("[mcp_servers.mailery]");
    expect(getCodexMcpConfig()).toContain('command = "mailery-mcp"');
    expect(getGeminiMcpConfig()).toEqual({ mcpServers: { mailery: { command: "mailery-mcp", args: [] } } });
  });
});
