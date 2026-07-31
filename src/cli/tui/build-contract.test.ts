import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const staticImport = /^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/gm;

describe("emails ui build contract", () => {
  it("keeps the main CLI external and builds a bundled TUI runtime", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const cliBuild = pkg.scripts["build:cli"] ?? "";
    const tuiRuntimeBuild = pkg.scripts["build:tui-runtime"] ?? "";
    const buildHelper = readFileSync(join(root, "scripts", "build-tui-runtime.ts"), "utf8");
    // The list literal only — the surrounding prose names the packages it must not contain.
    const externalStart = buildHelper.indexOf("const externalPackages = [");
    const externalConfiguration = buildHelper.slice(externalStart, buildHelper.indexOf("];", externalStart));

    expect(cliBuild).toContain("--packages external");
    expect(cliBuild).toContain("--splitting");
    expect(cliBuild).not.toContain("--packages bundle");
    expect(tuiRuntimeBuild).toContain("scripts/build-tui-runtime.ts");
    expect(pkg.dependencies["@opentui/core"]).toBe("0.4.1");
    expect(pkg.devDependencies["@opentui/core"]).toBeUndefined();
    expect(pkg.devDependencies["@opentui/keymap"]).toBe("0.4.1");
    expect(pkg.dependencies["@opentui/keymap"]).toBeUndefined();
    expect(pkg.devDependencies["@opentui/solid"]).toBe("0.4.1");
    expect(pkg.dependencies["@opentui/solid"]).toBeUndefined();
    expect(pkg.devDependencies["solid-js"]).toBe("1.9.13");
    expect(pkg.dependencies["solid-js"]).toBeUndefined();
    expect(buildHelper).toContain("src/cli/tui/runtime.tsx");
    expect(buildHelper).toContain("ui-runtime-bundle.[ext]");
    expect(buildHelper).not.toContain("--packages external");
    expect(buildHelper).toContain('from "@opentui/solid/bun-plugin"');
    expect(externalConfiguration).not.toContain("@opentui/keymap");
    expect(externalConfiguration).not.toContain("@opentui/solid");
    expect(externalConfiguration).not.toContain("solid-js");
    expect(buildHelper).toContain("createSolidTransformPlugin");
    // Guards the slice above: a renamed list would otherwise make every check on it vacuous.
    expect(externalConfiguration).toContain('"@aws-sdk/*"');
    // `@opentui/core` external, its prebuilts never named here. Listing a `@opentui/core-<platform>`
    // package externalises the prebuilt away from the module that dlopens it, which is what shipped
    // a UI that could not start in 1.3.4 — see src/cli/tui/ui-runtime-contract.test.ts.
    expect(externalConfiguration).toContain('"@opentui/core"');
    expect(externalConfiguration).not.toContain("@opentui/core-");
    expect(buildHelper).not.toContain("nativeBundleCandidates");
    expect(buildHelper).not.toContain("bundledNative");
  });

  it("runs the UI in alternate screen and keeps renderer cleanup on signal paths", () => {
    const source = readFileSync(join(root, "src", "cli", "tui-solid", "runtime.tsx"), "utf8");

    expect(source).toContain('process.env["OTUI_USE_ALTERNATE_SCREEN"] = "true"');
    expect(source).toContain('screenMode: "alternate-screen"');
    expect(source).toContain("clearOnShutdown: true");
    expect(source).toContain("process.once(signal, handler)");
    expect(source).toContain("renderer?.destroy()");
    expect(source).not.toContain("process.exit(1)");
  });

  it("keeps the command module lightweight and defers OpenTUI imports to the runtime", () => {
    const source = readFileSync(join(root, "src", "cli", "commands", "ui.tsx"), "utf8");

    expect(source).toContain("ui-runtime-bundle.js");
    expect(source).toContain("../../../dist/cli/ui-runtime-bundle.js");
    expect(source).toContain("../tui/runtime.js");
    expect(source).not.toContain('from "@opentui/core"');
    expect(source).not.toContain('from "@opentui/react"');
    expect(source).not.toContain('from "@opentui/solid"');
    expect(source).not.toContain('from "@opentui/keymap"');
    expect(source).not.toContain('from "react"');
    expect(source).not.toContain('from "solid-js"');
  });

  it("keeps local and self-hosted TUI send graphs isolated behind the mode router", () => {
    const source = readFileSync(join(root, "src", "cli", "tui", "data.ts"), "utf8");
    const localSource = readFileSync(join(root, "src", "cli", "tui", "data.local.ts"), "utf8");
    const remoteSource = readFileSync(join(root, "src", "cli", "tui", "data.remote.ts"), "utf8");
    const offenders = [...source.matchAll(staticImport)]
      .map((match) => match[1] ?? "")
      .filter((specifier) => specifier === "../../lib/send.js" || specifier.startsWith("../../lib/send.js"));

    expect(offenders).toEqual([]);
    expect(source).not.toContain('import("../../lib/send.js")');
    expect(source).toContain('from "./data.local.js"');
    expect(source).toContain('from "./data.remote.js"');
    expect(localSource).toContain('import("../../lib/send.local.js")');
    expect(remoteSource).toContain('selfHostedStoreFor("messages/send")');
  });
});
