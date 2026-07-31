import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

// `@opentui/core` stays external, and that is load-bearing rather than a size choice.
//
// Core ships its native renderer as per-platform prebuilt packages and loads one with a bare
// `import("@opentui/core-<platform>")` from inside its own module, so the version-matched
// prebuilt in `@opentui/core/node_modules/` is what answers. Bundling core moves that import
// into `dist/cli/`, where it resolves against the installed package's parents instead, misses
// core's own prebuilt entirely, and binds to whatever copy a global install happens to have
// hoisted — in 1.3.4 one whose libopentui.so predates the symbols core calls, so every
// `emails ui` in a real terminal died on `Symbol "createEventSink" not found`. A package that
// dlopens a prebuilt has to be the package that resolves it.
//
// The TUI tooling (@opentui/solid, @opentui/keymap, solid-js) stays bundled on purpose: it is
// a devDependency and must not ship as a runtime dependency.
//
// Everything listed here is imported from the installed package at runtime, so every entry
// must also be a declared runtime dependency — src/cli/tui/runtime-bundle-externals.test.ts
// enforces exactly that against the built artifact.
const externalPackages = [
  "@aws-sdk/*",
  "@hasna/domains",
  "@modelcontextprotocol/sdk",
  "@opentui/core",
  "mailparser",
  "pg",
  "resend",
  "zod",
  "chalk",
  "commander",
  "marked",
];

const result = await Bun.build({
  entrypoints: ["src/cli/tui/runtime.tsx"],
  outdir: "dist/cli",
  target: "bun",
  naming: "ui-runtime-bundle.[ext]",
  external: externalPackages,
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
