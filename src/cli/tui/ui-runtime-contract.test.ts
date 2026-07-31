import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";

// `dist/cli/ui-runtime-bundle.js` runs from inside the INSTALLED package, so every bare
// specifier it still imports is resolved from `<install>/@hasna/emails/dist/cli/`. Node and
// Bun walk upwards from there, which means an import of a package this manifest does not
// declare leaves the package tree and binds to whatever unrelated copy a global install
// happens to have hoisted.
//
// That is not hypothetical. `emails ui` 1.3.4 died in every real terminal with
//   Failed to initialize OpenTUI render library: Symbol "createEventSink" not found in
//   ".../node_modules/@opentui/core-linux-arm64/libopentui.so"
// because the build inlined `@opentui/core` but left its prebuilt platform packages
// external. `import("@opentui/core-linux-arm64")` then ran from `dist/cli/` instead of from
// inside `node_modules/@opentui/core/`, missed core's own version-matched prebuilt in
// `@opentui/core/node_modules/`, and loaded a foreign hoisted copy whose ABI predates the
// symbol core calls. A prebuilt native package must be resolved by the package that owns it.
const root = join(import.meta.dir, "..", "..", "..");
const bundlePath = join(root, "dist", "cli", "ui-runtime-bundle.js");

interface Manifest {
  dependencies?: Record<string, string>;
}

function declaredDependencies(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

// Bun's own transpiler reports both static and dynamic imports; a regex over 3MB of bundled
// output matches string literals in application data and cannot be trusted here.
function externalPackages(source: string): string[] {
  const specifiers = new Bun.Transpiler({ loader: "js" }).scanImports(source).map((entry) => entry.path);
  const bare = specifiers.filter(
    (specifier) =>
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("bun:") &&
      !isBuiltin(specifier),
  );
  return [...new Set(bare.map(packageNameOf))].sort();
}

// Always rebuild: a bundle left over from before a build-config regression would keep this
// guard green while the shipped artifact was already broken.
function buildRuntimeBundle(): void {
  const build = Bun.spawnSync(["bun", "run", "build:tui-runtime"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    throw new Error(`build:tui-runtime failed (${build.exitCode}): ${build.stderr.toString()}`);
  }
}

function bundleExternals(): string[] {
  buildRuntimeBundle();
  return externalPackages(readFileSync(bundlePath, "utf8"));
}

describe("packaged emails ui runtime contract", () => {
  it("imports only packages this manifest declares as runtime dependencies", () => {
    const externals = bundleExternals();
    const declared = declaredDependencies();

    // A bundle that externalises nothing would satisfy the filter below vacuously.
    expect(externals.length).toBeGreaterThan(0);
    expect(externals.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("leaves @opentui/core to load its own prebuilt native package", () => {
    const externals = bundleExternals();

    expect(externals).toContain("@opentui/core");
    // Any `@opentui/core-<platform>` here is core's prebuilt resolved from the wrong anchor.
    expect(externals.filter((name) => name.startsWith("@opentui/core-"))).toEqual([]);
  });

  it("refuses a non-interactive run with a non-zero exit code", async () => {
    // The refusal is the only thing a scripted caller sees, so it has to be distinguishable
    // from a UI that ran: exit 0 here would report success for a UI that never started.
    const proc = Bun.spawn({
      cmd: ["bun", "src/cli/index.tsx", "ui"],
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    expect(`${out}${err}`).toContain("requires a TTY terminal");
    expect(proc.exitCode).not.toBe(0);
  });

  it("flags an undeclared external, and only an undeclared one (positive control)", () => {
    const fixture = [
      'import { createRenderer } from "@opentui/core";',
      'const native = await import("@opentui/core-linux-arm64");',
      'import { readFileSync } from "node:fs";',
      'import { join } from "path";',
      'import { local } from "./local.js";',
    ].join("\n");

    // Builtins and relative specifiers never escape the package; bare ones do.
    expect(externalPackages(fixture)).toEqual(["@opentui/core", "@opentui/core-linux-arm64"]);
    expect(externalPackages(fixture).filter((name) => !declaredDependencies().has(name))).toEqual([
      "@opentui/core-linux-arm64",
    ]);
  });
});
