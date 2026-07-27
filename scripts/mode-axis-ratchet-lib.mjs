// How to MEASURE the size of the EMAILS_MODE deployment-mode axis. The ceilings
// themselves live in src/mode-axis-ratchet.test.ts so a reviewer reads the numbers
// next to the assertions that enforce them; this module only knows how to count.
//
// The axis is being deleted outright: one deployment story, "you run it", location
// is not a product variant. Today one variable carries two contradictory meanings —
// in the `emails` CLI `EMAILS_MODE=self_hosted` means "become an HTTP client", in
// `emails-serve` it means "become a Postgres server". Every counter below measures
// some part of that split, and every counter must end at zero.
//
// WHAT THESE COUNTERS CANNOT DO, stated plainly because the deletion gate depends on
// it: eight of the ten are keyed on NAMES, so a mechanical rename (`routed` ->
// `dispatch`, `EMAILS_MODE` -> `EMAILS_TOPOLOGY`, `*.remote.ts` -> `*.httparm.ts`)
// drives them all to zero with the two-arm structure completely intact. That is why
// `twoArmFamilies` exists: it is derived from FILE STRUCTURE rather than from any
// identifier, so it survives a rename and a rename alone cannot open the gate. It is
// still not a proof of deletion — no text scan is — and the deletion PR must be read,
// not merely measured.
//
// Counting lives here, apart from the test, for the same reason the no-cloud ban
// list lives in scripts/no-cloud-scan-lib.mjs: a module that defines the pattern
// literals cannot be scanned by them without matching itself. This file is the only
// corpus exemption, and the test asserts that it is the only one — and, because an
// exempt file is the obvious place to park the very code it excuses, the test also
// asserts this module has no imports and no environment access, so its literals can
// only ever be inert data.

/**
 * The one file excluded from the scanned corpus, and why. The test file is
 * deliberately NOT excluded — it names its metrics with suffixed keys
 * (`getEmailsModeReferences`, not the bare identifier) so it can be measured by the
 * very patterns it enforces.
 */
export const RATCHET_CORPUS_EXCLUSIONS = new Map([
  [
    "scripts/mode-axis-ratchet-lib.mjs",
    "single definition site of the counting patterns; it necessarily contains every literal it searches for",
  ],
]);

// Every extension a module can be written in, not just the two the axis happens to
// use today. A `.mjs` or `.mts` arm would otherwise be invisible, and this repo
// already tracks `.mjs` files — one of which runs at install time.
const MODULE_SOURCE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

/** `src/**` module paths only, so a fixture path outside src/ is a genuine miss. */
const SRC_MODULE = /^src\/.+\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

/**
 * Split a module path into `{ dir, base, suffix }`, where `suffix` is the last dotted
 * segment before the extension (`src/db/emails.remote.ts` -> suffix "remote") or null
 * when there is none (`src/db/emails.ts`). Used by the structural metric.
 */
function splitArm(path) {
  if (!SRC_MODULE.test(path)) return null;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = file.slice(0, dot);
  const inner = stem.lastIndexOf(".");
  if (inner < 0) return { dir, base: stem, suffix: null };
  return { dir, base: stem.slice(0, inner), suffix: stem.slice(inner + 1) };
}

// Suffixes that are not implementation arms. `test` and `d` are the only ones today;
// a new non-arm suffix must be added here deliberately rather than discovered.
const NON_ARM_SUFFIXES = new Set(["test", "d"]);

/**
 * Count families that still have TWO OR MORE implementation arms behind one facade:
 * a `dir/base.ts` that exists alongside at least two `dir/base.<suffix>.ts` modules.
 *
 * Identifier-independent on purpose. This is the metric a rename cannot move, and the
 * one that makes "the counts are zero" mean something more than "the words changed".
 */
function countTwoArmFamilies(paths) {
  const facades = new Set();
  const arms = new Map();
  for (const path of paths) {
    const parts = splitArm(path);
    if (!parts) continue;
    if (parts.suffix === null) {
      facades.add(`${parts.dir}/${parts.base}`);
      continue;
    }
    if (NON_ARM_SUFFIXES.has(parts.suffix)) continue;
    const key = `${parts.dir}/${parts.base}`;
    if (!arms.has(key)) arms.set(key, new Set());
    arms.get(key).add(parts.suffix);
  }
  let count = 0;
  for (const [key, suffixes] of arms) {
    if (suffixes.size >= 2 && facades.has(key)) count += 1;
  }
  return count;
}

/**
 * Every metric is one of three kinds:
 *  - `path`: counts FILES whose tracked path matches `matchesPath`.
 *  - `content`: counts OCCURRENCES of `patternSource` inside files selected by
 *    `matchesPath` (all scanned files when omitted).
 *  - `pathset`: counts a STRUCTURAL property of the whole path list via `countPaths`.
 *
 * `patternSource` is stored as a string, not a RegExp, so every count builds a fresh
 * global regex. A shared `/g` RegExp carries `lastIndex` between calls and would
 * undercount on the second file it visited.
 *
 * `positiveControl` is the load-bearing part. Repo counts legitimately fall to zero
 * as the axis is deleted, so "this metric currently finds something" cannot be the
 * proof that the metric still works. Each metric instead carries fixtures that must
 * match and fixtures that must not, checked against the pattern itself. That keeps
 * the guard honest at count zero — the state this program is driving toward.
 *
 * A content metric that also carries a `matchesPath` selector MUST supply `pathHits`
 * and `pathMisses` for it. Without them the selector was the one unproven part of the
 * measurement, and a one-character typo in it (`\.local\.ts$` -> `\.locl\.ts$`)
 * silently drove a 47-unit metric to zero with every other assertion still green — in
 * a program where reaching zero is the SUCCESS signal.
 */
export const MODE_AXIS_METRICS = [
  {
    key: "twoArmFamilies",
    kind: "pathset",
    what: "families that still have two or more implementation arms behind one facade (`x.ts` plus `x.<arm>.ts` twice over) — the two-arm structure itself, counted without reference to any identifier, so a rename cannot move it",
    countPaths: countTwoArmFamilies,
    positiveControl: {
      pathSetHits: [
        ["src/db/emails.ts", "src/db/emails.local.ts", "src/db/emails.remote.ts"],
        // A rename of both arms must NOT reduce this count. That is the whole point.
        ["src/db/emails.ts", "src/db/emails.sqlite.ts", "src/db/emails.httparm.ts"],
      ],
      pathSetMisses: [
        // One arm only: a family that has already collapsed.
        ["src/db/emails.ts", "src/db/emails.local.ts"],
        // Arms with no facade: nothing dispatches between them.
        ["src/db/emails.local.ts", "src/db/emails.remote.ts"],
        // Tests are not arms.
        ["src/db/emails.ts", "src/db/emails.test.ts", "src/db/emails.self-hosted.test.ts"],
        // Outside src/ is out of scope.
        ["dashboard/emails.ts", "dashboard/emails.local.ts", "dashboard/emails.remote.ts"],
      ],
    },
  },
  {
    key: "remoteArmModules",
    kind: "path",
    what: "`src/**/*.remote.*` HTTP-arm modules — the second implementation of every repository",
    matchesPath: (path) => /^src\/.*\.remote\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/.test(path),
    positiveControl: {
      hits: [
        "src/db/emails.remote.ts",
        "src/cli/tui/data.remote.ts",
        // Extension variants: the arm is the pattern, not the file type.
        "src/db/emails.remote.tsx",
        "src/db/emails.remote.mts",
      ],
      misses: [
        "src/db/emails.local.ts",
        "src/db/emails.ts",
        "src/db/remote.test.ts",
        "docs/remote.ts.md",
        "dashboard/db/emails.remote.ts",
      ],
    },
  },
  {
    key: "routedFacadeDefinitions",
    kind: "content",
    what: "definitions of the `routed` mode-dispatch helper — one per repository facade, in either the `function` or the `const` form",
    matchesPath: (path) => MODULE_SOURCE.test(path),
    // Both declaration forms. A `const routed = <K,>(key: K) => …` rewrite is a
    // one-line refactor that would otherwise drop this count to zero with all thirty
    // dispatchers still in place.
    patternSource: String.raw`\b(?:function|const|let|var)\s+routed\b`,
    positiveControl: {
      hits: [
        "function routed<K extends keyof typeof remote & keyof typeof local>(key: K) {",
        "const routed = <K,>(key: K) => local[key];",
        "let routed = makeDispatcher();",
      ],
      misses: ["function route<T>(x: T) {}", "const unrouted = 1;", "routed(key)"],
      pathHits: ["src/db/emails.ts", "src/cli/tui/data.ts", "scripts/x.mjs", "src/a.tsx"],
      pathMisses: ["README.md", "deploy/aws/compute.tf", "docker-compose.yml", "src/db/emails.json"],
    },
  },
  {
    key: "routedCallExpressions",
    kind: "content",
    what: "`routed(...)` call expressions — every exported function whose implementation is chosen by mode at runtime",
    matchesPath: (path) => MODULE_SOURCE.test(path),
    patternSource: String.raw`\brouted\(`,
    positiveControl: {
      hits: ['export const listEmails = routed("listEmails");', "routed(key)"],
      misses: ["unrouted(", "rerouted (", "function routed <"],
      pathHits: ["src/db/emails.ts", "scripts/x.mjs", "src/a.tsx"],
      pathMisses: ["README.md", "deploy/aws/compute.tf", "docker-compose.yml"],
    },
  },
  {
    key: "selfHostedResourceBranches",
    kind: "content",
    what: "mode-gated `selfHostedResource(...)` branches inside `*.local.*` — the local arm asking whether it is really the local arm",
    matchesPath: (path) => /^src\/.*\.local\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/.test(path),
    patternSource: String.raw`\bselfHostedResource\(`,
    positiveControl: {
      hits: ['const store = selfHostedResource("contacts");', "if (selfHostedResource(RESOURCE)) return null;"],
      misses: ["selfHostedResourceStore(", "selfHostedResource ("],
      pathHits: ["src/db/contacts.local.ts", "src/cli/commands/inbox.local.ts", "src/db/x.local.mts"],
      pathMisses: [
        "src/db/contacts.remote.ts",
        "src/db/contacts.ts",
        "src/db/self-hosted-resource.ts",
        "src/db/contacts.local.test.ts",
      ],
    },
  },
  {
    key: "selfHostedResourceReferences",
    kind: "content",
    what: "`selfHostedResource(...)` anywhere in the tree, not only in the local arm — the `*.local.*` count above is a subset, and without this one the gate could reach zero with the majority of the call sites untouched",
    patternSource: String.raw`\bselfHostedResource\(`,
    positiveControl: {
      hits: ['selfHostedResource("providers")', "export function selfHostedResource(resource: string)"],
      misses: ["selfHostedResourceStore(", "selfHostedResource ("],
    },
  },
  {
    key: "isSelfHostedModeReferences",
    kind: "content",
    what: "`isSelfHostedMode` references — the client-side and server-side mode predicate",
    patternSource: String.raw`\bisSelfHostedMode\b`,
    positiveControl: {
      hits: ["if (isSelfHostedMode()) return remote;", "export function isSelfHostedMode(): boolean {"],
      misses: ["isSelfHostedModeish(", "isSelfHostedModes(", "notisSelfHostedMode"],
    },
  },
  {
    key: "getEmailsModeReferences",
    kind: "content",
    what: "`getEmailsMode` references — the process-wide mode read",
    patternSource: String.raw`\bgetEmailsMode\b`,
    positiveControl: {
      hits: ['if (getEmailsMode() === "local") {'],
      misses: ["getEmailsModeLabel(", "forgetEmailsMode", "getEmailsModes("],
    },
  },
  {
    key: "resolveEmailsModeReferences",
    kind: "content",
    what: "`resolveEmailsMode` / `resolveEmailsModeSelection` references — mode resolution, including the credential-free selection variant",
    // The alternation is enumerated rather than left as a bare prefix. A prefix match
    // would also count the ratchet test's own metric key (`resolveEmailsModeReferences`),
    // which would make the guard count itself and break the "the ratchet contributes
    // zero" property that lets it live inside its own corpus.
    patternSource: String.raw`\bresolveEmailsMode(?:Selection)?\b`,
    positiveControl: {
      hits: ["resolveEmailsMode(env)", "resolveEmailsModeSelection(env)"],
      misses: ["unresolveEmailsMode(", "resolveEmailsModeReferences", "resolveEmailsModes("],
    },
  },
  {
    key: "normalizeEmailsModeReferences",
    kind: "content",
    what: "`normalizeEmailsMode` references — the parser that admits the two mode values",
    patternSource: String.raw`\bnormalizeEmailsMode\b`,
    positiveControl: {
      hits: ["const mode = normalizeEmailsMode(value);"],
      misses: ["normalizeEmailsModeValue(", "denormalizeEmailsMode", "normalizeEmailsModes("],
    },
  },
  {
    key: "emailsModeEnvReferences",
    kind: "content",
    what: "`EMAILS_MODE` occurrences anywhere in the tree. Deliberately a substring match, so the `HASNA_` prefix and the `_ENV` / `_CONFIG_KEY` / `_ENV_KEYS` derivatives all count, and so do docs, Terraform and compose files — the variable is being deleted everywhere, not just in TypeScript",
    patternSource: "EMAILS_MODE",
    positiveControl: {
      hits: [
        "EMAILS_MODE=local",
        "HASNA_EMAILS_MODE",
        'export const EMAILS_MODE_ENV = "EMAILS_MODE";',
        "EMAILS_MODE_CONFIG_KEY",
      ],
      misses: ["EMAILS_SELF_HOSTED_URL", "MAILERY_MODE", "EMAILS_STORAGE_MODE", "emails_mode", "EMAILS-MODE"],
    },
  },
];

/** Occurrences of one metric's pattern in one file's text. */
export function countOccurrences(patternSource, content) {
  return content.match(new RegExp(patternSource, "g"))?.length ?? 0;
}

/**
 * Count every metric over `files` (each `{ path, content }`). Returns
 * `{ counts, byFile }`: totals per metric key, plus the per-file breakdown that
 * turns a ratchet failure into "which file did this".
 */
export function measureModeAxis(files) {
  const counts = {};
  const byFile = {};
  for (const metric of MODE_AXIS_METRICS) {
    if (metric.kind === "pathset") {
      counts[metric.key] = metric.countPaths(files.map((file) => file.path));
      byFile[metric.key] = [];
      continue;
    }
    const selected = metric.matchesPath ? files.filter((file) => metric.matchesPath(file.path)) : files;
    if (metric.kind === "path") {
      counts[metric.key] = selected.length;
      byFile[metric.key] = selected.map((file) => ({ path: file.path, count: 1 }));
      continue;
    }
    const hits = selected
      .map((file) => ({ path: file.path, count: countOccurrences(metric.patternSource, file.content) }))
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    counts[metric.key] = hits.reduce((total, entry) => total + entry.count, 0);
    byFile[metric.key] = hits;
  }
  return { counts, byFile };
}

/**
 * Check one metric against its own fixtures. Returns the fixtures that behaved
 * wrongly, so a broken or over-broad pattern is named rather than merely counted.
 *
 * Three surfaces are checked, and all three used to matter:
 *  - the content pattern (`hits` / `misses`);
 *  - the PATH SELECTOR of a content metric (`pathHits` / `pathMisses`) — unproven
 *    until a typo in one silently zeroed three metrics at once;
 *  - the structural counter (`pathSetHits` / `pathSetMisses`).
 */
export function positiveControlFailures(metric) {
  const control = metric.positiveControl;
  const missedHits = [];
  const falsePositives = [];

  if (metric.kind === "pathset") {
    for (const fixture of control.pathSetHits) {
      if (metric.countPaths(fixture) === 0) missedHits.push(fixture.join(" + "));
    }
    for (const fixture of control.pathSetMisses) {
      if (metric.countPaths(fixture) !== 0) falsePositives.push(fixture.join(" + "));
    }
    return { missedHits, falsePositives };
  }

  const detects =
    metric.kind === "path"
      ? (fixture) => metric.matchesPath(fixture)
      : (fixture) => countOccurrences(metric.patternSource, fixture) > 0;
  for (const fixture of control.hits) if (!detects(fixture)) missedHits.push(fixture);
  for (const fixture of control.misses) if (detects(fixture)) falsePositives.push(fixture);

  if (metric.kind === "content" && metric.matchesPath) {
    for (const fixture of control.pathHits ?? []) {
      if (!metric.matchesPath(fixture)) missedHits.push(`path: ${fixture}`);
    }
    for (const fixture of control.pathMisses ?? []) {
      if (metric.matchesPath(fixture)) falsePositives.push(`path: ${fixture}`);
    }
  }
  return { missedHits, falsePositives };
}
