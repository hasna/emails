import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITY_KEYS,
  capabilityRefusal,
  isCapabilityRefusal,
  unavailableCapabilities,
  type CapabilityKey,
  type StoreCapabilities,
} from "./store/capabilities.js";
import {
  CONFORMANCE_CASES,
  assertUniformCaseCoverage,
  capabilityCoverageGaps,
  conformanceFailures,
  runConformanceSuite,
  type ConformanceCase,
  type ConformanceReport,
} from "./store/conformance.js";
import type { EmailStore } from "./store/email-store.js";

// The seam guard. It lives OUTSIDE src/store/ on purpose: it has to spell out the
// constructs it forbids, and a guard that sits inside its own scan area either matches
// itself or needs a self-exemption — and a self-exemption is a hole big enough to park
// the banned construct in.
//
// What it enforces, and why each rule is here rather than in a review checklist:
//
//   * NO INHERITANCE, NO DERIVED-FROM-CLASS TYPES. A base class with a default method
//     body lets an implementation inherit an answer for a method it never wrote, which
//     is the mechanism behind exported functions that return plausible wrong data
//     instead of refusing. With no parent, `tsc` turns a missing method into a build
//     error. Selecting
//     or subtracting members of an existing CLASS is banned for a different reason: a
//     class with `private` fields is NOMINALLY typed, so a type derived from it can
//     only be satisfied by that class, which rebuilds exactly the unsubstitutability
//     this refactor removes.
//   * SELF-CONTAINED. `src/store/**` imports nothing from outside `src/store/`, so the
//     seam cannot be nominally tied to an existing implementation and cannot drag a
//     database driver into a client bundle.
//   * SCOPE IS NOT AN ARGUMENT. No tenant id appears in any signature. In the Postgres
//     store the tenant is fixed at construction, which is why unscoped access there is
//     a compile error; a per-call tenant id would hand that guarantee back to runtime.
//   * EVERYTHING ASYNC. The synchronous repositories only work because the HTTP arm
//     shells out to `curl` via `spawnSync`; that dies with this refactor, so a
//     non-Promise store operation is a build-time bug, not a future problem.
//
// The scan strips comments before matching. That is deliberate and load-bearing in
// both directions: prose has to be able to NAME the constructs it forbids (this file
// and the seam's own doc comments both do), while the CODE may not contain them.

const storeDir = join(import.meta.dir, "store");

/**
 * Remove comments so the ban patterns match code only.
 *
 * A SINGLE-PASS SCANNER, not a pair of regexes, and the reason is a bug this guard was
 * caught with before it landed: the first version stripped block-comment spans first,
 * and the very first LINE comment in repositories.ts contains the glob "src/db/" plus a
 * star. That opened a block comment which ran to the next block-comment terminator
 * sixty lines later, deleting the imports and the entire first interface — so the ban
 * patterns scanned a file with its head cut off, reported clean, and an added
 * `interface X extends Y` sat undetected in the hole.
 *
 * Comment and string state are mutually exclusive and have to be tracked together: a
 * block opener inside a line comment opens nothing, a line opener inside a block closes
 * nothing, and neither means anything inside a string literal. Newlines are preserved
 * so the per-line member regex below still sees line starts.
 *
 * REGEX LITERALS ARE NOT TRACKED, and are BANNED instead (see the ban list). A literal
 * containing a block opener — `/^[A-Za-z0-9\/*+=]+$/` — would otherwise open a comment
 * and erase the rest of the file, and one containing a quote would mis-enter string
 * state and stop stripping the prose after it. Recognising a regex literal correctly
 * needs a real lexer, because `/` is ambiguous; a types-only seam has no use for one, so
 * forbidding it is both simpler and stricter than parsing it. The head and tail anchors
 * below are the backstop: any span-eating bug that reaches either end of a file fails.
 */
function stripComments(source: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let out = "";
  let state: State = "code";
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 2;
        out += " ";
        continue;
      }
      if (char === '"') state = "double";
      else if (char === "'") state = "single";
      else if (char === "`") state = "template";
      out += char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      if (char === "\n") out += char;
      index += 1;
      continue;
    }
    // Inside a string literal: only its own terminator (unescaped) ends it.
    if (char === "\\") {
      out += char + (next ?? "");
      index += 2;
      continue;
    }
    if (
      (state === "double" && char === '"') ||
      (state === "single" && char === "'") ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * One code anchor per seam file — the declaration nearest the top of each, so an
 * over-eager stripper that eats a file's head is caught.
 *
 * This is the assertion whose absence let the stripper bug above hide: every other
 * check still found plenty to look at in the surviving two thirds of the file and
 * passed. "The scan found something" is not the same as "the scan found everything".
 */
const CODE_ANCHORS: Record<string, string> = {
  "capabilities.ts": "export const CAPABILITY_KEYS",
  "conformance.ts": "export const CONFORMANCE_CASES",
  "descriptor.ts": "export interface StoreDescriptor",
  "email-store.ts": "export interface EmailStore",
  "index.ts": "export type { Outcome",
  "outcome.ts": "export type RefusalStatus",
  "records.ts": "export interface ListOptions",
  "repositories.ts": "export interface DomainsRepository",
};

/**
 * A second anchor per file, near the BOTTOM. The head anchors catch a stripper bug that
 * eats a file's opening; a bug that starts mid-file and runs to EOF — which is what a
 * stray block opener in a regex literal does — only shows up here.
 */
const TAIL_ANCHORS: Record<string, string> = {
  "capabilities.ts": "export function unavailableCapabilities",
  "conformance.ts": "export function capabilityCoverageGaps",
  "descriptor.ts": "readonly detail: string;",
  "email-store.ts": "readonly attachmentRepair: AttachmentRepairRepository;",
  "index.ts": "} from \"./conformance.js\";",
  "outcome.ts": "export type Outcome<TValue>",
  "records.ts": "export type ResourceInput",
  "repositories.ts": "export type SandboxRepository",
};

interface SeamFile {
  name: string;
  source: string;
  code: string;
}

/**
 * Every seam file, RECURSIVELY. A non-recursive read would leave
 * `src/store/base/repo.ts` outside the scan — a subdirectory is the obvious place to
 * park the base class this guard exists to forbid.
 */
function seamFiles(): SeamFile[] {
  const walk = (dir: string, prefix: string): SeamFile[] =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const name = prefix + entry.name;
        if (entry.isDirectory()) return walk(join(dir, entry.name), `${name}/`);
        if (!entry.name.endsWith(".ts")) return [];
        const source = readFileSync(join(dir, entry.name), "utf8");
        return [{ name, source, code: stripComments(source) }];
      });
  return walk(storeDir, "");
}

// Eight files today. A floor well above zero makes "the directory stopped resolving"
// a red test instead of a green run over nothing — the failure mode that let a pack
// guard certify an empty tarball in this repo.
const MINIMUM_SEAM_FILES = 5;
const MINIMUM_SEAM_CODE_CHARS = 5_000;

/**
 * The files that declare the contract and contain no runtime logic. A few rules apply
 * only here, because `conformance.ts` legitimately holds executable code (arrow
 * callbacks, an array spread) that a declaration file has no reason to.
 */
const DECLARATION_FILES = ["descriptor.ts", "email-store.ts", "outcome.ts", "records.ts", "repositories.ts"];

/**
 * The forbidden constructs, each with fixtures that must fire and fixtures that must
 * not. Repo counts are not the proof a pattern works — `src/store/**` is supposed to
 * contain none of these — so every pattern is checked against its own fixtures.
 */
const BANNED = [
  {
    label: "class declaration",
    pattern: /\bclass\s+[A-Za-z_$]/,
    hits: ["export abstract class BaseStore {", "class SqliteRepo {"],
    misses: ["const klass = 1;", "type ClassLike = { a: 1 };"],
  },
  {
    label: "abstract member or class",
    pattern: /\babstract\b/,
    hits: ["abstract listDomains(): Promise<void>;"],
    misses: ["const abstraction = 1;", "type Abstract = 1;"],
  },
  {
    label: "inheritance",
    pattern: /\bextends\b/,
    hits: [
      "interface Messages extends BaseRepo {",
      "class A extends B {}",
      "type Row<T extends object> = T;",
    ],
    misses: ["type Extended = { a: 1 };", "const extendsRule = 1;"],
  },
  {
    label: "implements clause",
    pattern: /\bimplements\b/,
    hits: ["class Sqlite implements EmailStore {"],
    misses: ["const implementsIt = true;"],
  },
  {
    label: "optional-everything type",
    pattern: /\bPartial\s*</,
    hits: ["type Caps = Partial<StoreCapabilities>;", "Partial <X>"],
    misses: ["type PartialLike = 1;", "// Partial is banned"],
  },
  {
    label: "member selection from an existing type",
    pattern: /\bPick\s*</,
    hits: ["type R = Pick<TenantScopedStore, 'listDomains'>;"],
    misses: ["const picked = 1;", "type Picker = 1;"],
  },
  {
    label: "member subtraction from an existing type",
    pattern: /\bOmit\s*</,
    hits: ["type L = Omit<MessageRecord, 'body_text'>;"],
    misses: ["const omitted = 1;"],
  },
  {
    label: "runtime merging of defaults",
    pattern: /Object\s*\.\s*assign/,
    hits: ["Object.assign(store, defaults);", "Object . assign(a, b)"],
    misses: ["const assigned = 1;", "objectAssignish(a)"],
  },
  {
    label: "prototype surgery",
    pattern: /\bprototype\b/,
    hits: ["Repo.prototype.list = () => [];"],
    misses: ["const prototypical = 1;"],
  },
  {
    // A member written as an arrow-typed PROPERTY rather than a method would slip past
    // the async check below, which matches method syntax. Banning the form is simpler
    // and stricter than teaching the matcher two grammars.
    label: "arrow-typed member",
    pattern: /^\s+(?:readonly\s+)?\w+\s*\??\s*:\s*\(/m,
    hits: ["  list: (opts?: ListOptions) => Promise<Row[]>;", "  readonly get?: () => void;"],
    misses: ["  list(opts?: ListOptions): Promise<Row[]>;", "  readonly descriptor: StoreDescriptor;"],
  },
  {
    // An accessor cannot return a Promise the caller can await in the same way, and it
    // hides work behind property syntax. Store operations are methods.
    label: "accessor member",
    pattern: /^\s+(?:get|set)\s+\w+\s*\(/m,
    hits: ["  get capabilities(): StoreCapabilities;", "  set kind(value: string);"],
    misses: ["  getDomain(id: string): Promise<DomainRecord | null>;", "  settings(): Promise<void>;"],
  },
  {
    // Spread and Reflect are the same defaults-merging move as Object.assign.
    label: "reflective default merging",
    pattern: /\bReflect\s*\.\s*(?:set|defineProperty)|\bObject\s*\[/,
    hits: ["Reflect.set(store, 'list', fallback);", 'Object["assign"]({}, base, impl)'],
    misses: ["const reflected = 1;", "reflectSetup()"],
  },
  {
    // `{ ...DEFAULT_REPO, ...impl }` is Object.assign with different punctuation, and
    // spread has no legitimate use in a declaration-only directory.
    label: "spread merging",
    pattern: /\.\.\./,
    hits: ["const repo = { ...DEFAULT_REPO, ...impl };", "return { ...base, ...impl };"],
    misses: ["const a = 1;", "a.b.c"],
    // Declaration files only. The conformance harness copies arrays with `[...cases]`
    // deliberately — that snapshot is what stops a case list being mutated mid-run — and
    // banning the syntax there would forbid the fix rather than the failure.
    filesScanned: DECLARATION_FILES,
  },
  {
    // A regex literal defeats the comment stripper (see stripComments). None is needed
    // in a types-only seam, so the construct is forbidden rather than parsed.
    label: "regular-expression literal",
    pattern: /[=(,:[]\s*\/(?![/*])/,
    hits: ["const CURSOR_RE = /^[a-z]+$/;", "if (re.test(/a/)) {}", "const list = [/x/];"],
    misses: ["const path = dir + \"/a\";", "// a / b", "const q = a / b;", "import x from \"./y.js\";"],
  },
  {
    // Type-level derivation from an existing type, the family `Pick`/`Omit` belong to.
    // Reachable only by importing a class, which the self-containment rule already
    // blocks — banned as well so the two rules are not load-bearing for each other.
    label: "type-level derivation from another type",
    pattern: /\bkeyof\b|\b(?:InstanceType|ReturnType|Parameters|ConstructorParameters|Exclude|Extract|Required)\s*</,
    hits: ["type K = keyof TenantScopedStore;", "type R = ReturnType<typeof f>;"],
    misses: ["const keyofish = 1;", "type Keys = \"a\" | \"b\";"],
  },
  {
    // A function-type ALIAS used as a member type is the arrow-typed member with a name
    // in front of it, and it evades the async check the same way.
    label: "function-type alias",
    pattern: /=>/,
    hits: ["type SyncLister = (opts?: ListOptions) => Row[];", "list: () => void;"],
    misses: ["const a = 1;", "type Row = { a: string };", "a >= b"],
    filesScanned: DECLARATION_FILES,
  },
];

describe("store seam", () => {
  it("scans a directory that is neither empty nor unreadable", () => {
    const files = seamFiles();
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_SEAM_FILES);
    expect(files.reduce((total, file) => total + file.code.length, 0)).toBeGreaterThan(
      MINIMUM_SEAM_CODE_CHARS,
    );
    // The seam's entry points must all be present; a renamed file silently narrowing
    // the scan is the same failure as an empty scan.
    expect(files.map((file) => file.name)).toEqual([
      "capabilities.ts",
      "conformance.ts",
      "descriptor.ts",
      "email-store.ts",
      "index.ts",
      "outcome.ts",
      "records.ts",
      "repositories.ts",
    ]);
  });

  it("proves every ban pattern still fires, independently of repo content", () => {
    for (const rule of BANNED) {
      expect(rule.hits.filter((fixture) => !rule.pattern.test(fixture))).toEqual([]);
      expect(rule.misses.filter((fixture) => rule.pattern.test(fixture))).toEqual([]);
    }
    // The comment stripper is part of the guard, so it gets fixtures too: it must hide
    // a banned token in prose and must NOT hide one in code.
    expect(stripComments("const a = 1; // extends B\n")).not.toContain("extends");
    expect(stripComments("/* Pick<X> */ const a = 1;")).not.toContain("Pick<");
    expect(stripComments("class A extends B {} // fine\n")).toContain("extends");
    expect(stripComments('const u = "https://example.test/x"; // note\n')).toContain("https://");
    // The three cases the regex version got wrong. Each one hid real code.
    expect(stripComments("// glob src/db/*\nclass A extends B {}\n")).toContain("extends");
    expect(stripComments("/* a // b */ class A extends B {}")).toContain("extends");
    expect(stripComments('const s = "/*"; class A extends B {}')).toContain("extends");
  });

  it("keeps every seam file's head inside the scan", () => {
    // The check whose absence let a broken stripper report clean: the ban patterns still
    // found plenty to look at in the surviving part of the file. "Found something" is
    // not "found everything".
    const files = seamFiles();
    expect(Object.keys(CODE_ANCHORS).sort()).toEqual(files.map((file) => file.name));
    expect(Object.keys(TAIL_ANCHORS).sort()).toEqual(files.map((file) => file.name));
    for (const file of files) {
      for (const [where, table] of [["head", CODE_ANCHORS], ["tail", TAIL_ANCHORS]] as const) {
        const anchor = (table as Record<string, string>)[file.name] as string;
        expect(file.source, `${file.name} no longer contains its ${where} anchor`).toContain(anchor);
        expect(file.code, `${file.name} lost ${where} code to the comment stripper`).toContain(anchor);
      }
    }
  });

  it("forbids inheritance and class-derived types in every seam file", () => {
    const files = seamFiles();
    for (const rule of BANNED) {
      // Most rules apply to the whole directory. A few apply only to the DECLARATION
      // files, because the harness in conformance.ts legitimately contains runtime code
      // (arrow callbacks, a spread) that a declaration file has no reason to.
      const scanned = rule.filesScanned
        ? files.filter((file) => (rule.filesScanned as string[]).includes(file.name))
        : files;
      expect(scanned.length, `${rule.label} scanned no files`).toBeGreaterThan(0);
      const offenders = scanned.filter((file) => rule.pattern.test(file.code)).map((file) => file.name);
      expect(offenders, `${rule.label} is banned under src/store/**`).toEqual([]);
    }
  });

  it("keeps the seam self-contained", () => {
    for (const file of seamFiles()) {
      // EVERY specifier form, not just double-quoted `from "…"`. Single quotes and the
      // type-only `import("…").T` syntax were both open doors, and each was exactly the
      // failure the self-containment rule exists to prevent: a nominal tie to a class
      // with `private` fields, and a database driver in the client graph.
      const specifiers = [
        ...file.code.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g),
      ].map((match) => match[1] as string);
      expect(specifiers.length, `${file.name} has no resolvable specifiers to check`).toBeGreaterThanOrEqual(0);
      // Relative, single-segment, inside this directory: no package import, no parent
      // traversal, no subdirectory.
      expect(
        specifiers.filter((specifier) => !/^\.\/[a-z-]+\.js$/.test(specifier)),
        `${file.name} imports outside src/store/`,
      ).toEqual([]);
    }
  });

  it("admits no scope identifier into any signature", () => {
    // Every spelling a per-call scope argument realistically takes, not just one. The
    // capability key `tenantScoping` was removed, so the word "tenant" now appears in
    // seam CODE only if someone reintroduces a scope argument.
    const SCOPE_ID =
      /\b(?:tenant_?id|tenant_?key|tenant_?slug|tenant_?uuid|org_?id|organi[sz]ation_?id|workspace_?id|account_?id|scope_?id)\b/i;
    for (const file of seamFiles()) {
      expect(file.code, `${file.name} names a scope identifier`).not.toMatch(SCOPE_ID);
    }
    // Positive control: the pattern must fire on the forms it claims to cover.
    for (const fixture of ["tenantId: string", "tenant_id", "orgId", "workspace_id", "scopeId"]) {
      expect(SCOPE_ID.test(fixture), `${fixture} must be detected`).toBe(true);
    }
    for (const fixture of ["tenantScoping", "detail: string", "descriptor"]) {
      expect(SCOPE_ID.test(fixture), `${fixture} must not be detected`).toBe(false);
    }
  });

  it("declares every store operation as async", () => {
    // BOTH declaration files. Scanning only repositories.ts left `close(): void;` on
    // EmailStore itself completely unchecked.
    const code = ["repositories.ts", "email-store.ts"]
      .map((name) => stripComments(readFileSync(join(storeDir, name), "utf8")))
      .join("\n");
    // Whitespace is collapsed FIRST so a signature broken across lines is still
    // matched. A per-line matcher simply would not match it, and "not matched" is not
    // "returns a Promise" — the same silent-shortfall failure as a scan that resolves
    // no files. The arrow-typed-member and accessor bans above close the two other
    // grammars a member could hide in, so method syntax is the only remaining form.
    //
    // Only repositories.ts is scanned: conformance.ts also declares members, but those
    // are harness callbacks (`expect(value)` asserts synchronously), not operations a
    // store performs.
    const flat = code.replace(/\s+/g, " ");
    // A member may be generic (`get<T>(…)`) and its parameters may nest parens two deep
    // (a callback taking a callback); both forms went unmatched, and "unmatched" is not
    // "async". Comma-separated members are banned outright below, because allowing them
    // would need a third grammar here.
    const MEMBER =
      /(?<=[;{] )(\w+)(?:<[^<>]*>)?\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\): ([^;]+);/g;
    const members = [...flat.matchAll(MEMBER)];
    // Positive control for the matcher itself: each of these forms MUST be seen.
    for (const fixture of [
      "{ list(): Promise<void>; }",
      "{ get<T>(id: string): Promise<T>; }",
      "{ watch(on: (e: (r: Row) => void) => void): Promise<void>; }",
    ]) {
      const flatFixture = fixture.replace(/\s+/g, " ");
      expect([...flatFixture.matchAll(MEMBER)].length, `matcher missed: ${fixture}`).toBe(1);
    }
    // Comma-separated members are valid TS and would defeat the `;`-anchored matcher.
    expect(flat, "store operations must be separated by semicolons").not.toMatch(/\)\s*:\s*[^;{]*,\s*\w+\s*\(/);
    // A floor, because a matcher that stopped matching would report "all async" over an
    // empty set — the same vacuity the ban patterns guard against.
    expect(members.length).toBeGreaterThan(60);
    const synchronous = members
      .filter((match) => !(match[2] as string).trim().startsWith("Promise<"))
      .map((match) => match[1] as string);
    expect(synchronous, "every store operation must return a Promise").toEqual([]);
  });

  it("keeps the diagnostics descriptor un-narrowable", () => {
    const code = stripComments(readFileSync(join(storeDir, "descriptor.ts"), "utf8"));
    // `kind: string`, never a union of store names. A union narrows, and narrowing is
    // what turned MailDataSource.mode from a label into ~6 deployment-mode branches.
    //
    // Presence of the right declaration is NOT enough: a decoy interface carrying
    // `readonly kind: string` satisfies a bare `toMatch` while the real one takes a
    // narrowing alias. So the file must contain EXACTLY ONE `kind` member, exactly one
    // exported declaration, and no string-literal type or union anywhere in it.
    const kindMembers = [...code.matchAll(/readonly kind:\s*([^;]+);/g)].map((match) => match[1] as string);
    expect(kindMembers).toEqual(["string"]);
    expect([...code.matchAll(/^export /gm)].length, "descriptor.ts declares one thing").toBe(1);
    expect(code, "no string-literal type may appear in descriptor.ts").not.toMatch(/:\s*"/);
    expect(code, "no union may appear in descriptor.ts").not.toMatch(/\|/);
  });

  it("maps one repository onto every src/db family", () => {
    const dbDir = join(import.meta.dir, "db");
    const families = readdirSync(dbDir)
      .filter((name) => name.endsWith(".local.ts"))
      .map((name) => name.slice(0, -".local.ts".length))
      .sort();
    expect(families.length).toBeGreaterThan(20);

    // `self-hosted-resource` is routing infrastructure shared BY the families, not a
    // family: it owns no rows. It is the one exclusion, named here so adding another
    // is a visible diff.
    const notAFamily = ["self-hosted-resource"];
    const familyToRepository: Record<string, string> = {
      addresses: "addresses",
      "address-lifecycle": "addressLifecycle",
      aliases: "aliases",
      contacts: "contacts",
      domains: "domains",
      "email-content": "emailContent",
      "email-digests": "emailDigests",
      emails: "messages",
      events: "events",
      forwarding: "forwarding",
      groups: "groups",
      inbound: "inbound",
      owners: "owners",
      providers: "providers",
      provisioning: "provisioning",
      sandbox: "sandbox",
      scheduled: "scheduled",
      "send-keys": "sendKeys",
      sequences: "sequences",
      templates: "templates",
      threads: "threads",
      warming: "warming",
      "webhook-receipts": "webhookReceipts",
    };
    // No family may be forgotten, and no mapping may name a family that is gone.
    expect(families.filter((family) => !notAFamily.includes(family)).sort()).toEqual(
      Object.keys(familyToRepository).sort(),
    );

    const storeCode = stripComments(readFileSync(join(storeDir, "email-store.ts"), "utf8"));
    const declared = [...storeCode.matchAll(/^\s+readonly (\w+):\s*(\w+);/gm)].map(
      (match) => match[1] as string,
    );
    expect(declared.length).toBeGreaterThan(20);
    // Families the STRONGEST arm has and src/db never did. Declared explicitly so an
    // unmapped repository cannot hide among them.
    const serverOnly = ["sendIntents", "attachmentRepair"];
    const diagnostics = ["descriptor", "capabilities"];
    expect(
      declared.filter(
        (name) =>
          !Object.values(familyToRepository).includes(name) &&
          !serverOnly.includes(name) &&
          !diagnostics.includes(name),
      ),
      "EmailStore declares a repository that maps to no src/db family",
    ).toEqual([]);
    expect(
      Object.values(familyToRepository).filter((name) => !declared.includes(name)),
      "a src/db family has no repository on EmailStore",
    ).toEqual([]);
  });
});

// ---- the capability rule ----------------------------------------------------

function capabilities(overrides: Partial<Record<CapabilityKey, boolean>> = {}): StoreCapabilities {
  const all = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true]));
  return { ...all, ...overrides } as StoreCapabilities;
}

/**
 * A fixture store. Only `descriptor.kind` and `capabilities` are read by the harness,
 * so the rest is cast away rather than stubbed out — 25 fake repositories would test
 * the fixture, not the harness.
 */
function fixtureStore(kind: string, caps: StoreCapabilities): EmailStore {
  return { descriptor: { kind, detail: `${kind} fixture` }, capabilities: caps } as unknown as EmailStore;
}

describe("capability refusals", () => {
  it("has exactly one refusal shape, and recognises it", () => {
    const refusal = capabilityRefusal("rawMessage", "sqlite");
    expect(refusal).toEqual({
      ok: false,
      code: "capability_unavailable",
      message: "the sqlite store does not provide rawMessage",
      status: 501,
    });
    expect(isCapabilityRefusal(refusal)).toBe(true);
  });

  it("does not mistake a plausible wrong answer for a refusal", () => {
    // The whole point. Each of these is what an arm returns TODAY instead of admitting
    // it cannot do the thing, and none of them may pass as a refusal.
    expect(isCapabilityRefusal({ ok: true, value: [] })).toBe(false);
    expect(isCapabilityRefusal({ ok: true, value: 0 })).toBe(false);
    expect(isCapabilityRefusal({ ok: true, value: null })).toBe(false);
    expect(isCapabilityRefusal([])).toBe(false);
    expect(isCapabilityRefusal(null)).toBe(false);
    expect(isCapabilityRefusal(undefined)).toBe(false);
    // A refusal with the wrong code or status is not the canonical one either.
    expect(isCapabilityRefusal({ ok: false, code: "not_found", status: 404 })).toBe(false);
    expect(isCapabilityRefusal({ ok: false, code: "capability_unavailable", status: 403 })).toBe(false);
    // A refusal with no message, or a non-string one, is not the canonical shape.
    expect(isCapabilityRefusal({ ok: false, code: "capability_unavailable", status: 501 })).toBe(false);
    expect(isCapabilityRefusal({ ok: false, code: "capability_unavailable", status: 501, message: 42 })).toBe(false);
    // And a BLANKET refusal cannot answer for a capability it does not name — otherwise
    // one hard-coded blob passes every case a store declares false.
    const raw = capabilityRefusal("rawMessage", "sqlite");
    expect(isCapabilityRefusal(raw, "rawMessage")).toBe(true);
    expect(isCapabilityRefusal(raw, "mailRollups")).toBe(false);
  });

  it("reports which capabilities a store declares false", () => {
    expect(unavailableCapabilities(capabilities())).toEqual([]);
    expect(unavailableCapabilities(capabilities({ sendIntentLedger: false, rawMessage: false }))).toEqual([
      "rawMessage",
      "sendIntentLedger",
    ]);
    // Order follows CAPABILITY_KEYS, so the report is stable across runs.
    expect(CAPABILITY_KEYS.indexOf("rawMessage")).toBeLessThan(CAPABILITY_KEYS.indexOf("sendIntentLedger"));
    // Scope is NOT a capability: it is structural (no signature takes a scope id), so
    // there is no operation for a case to exercise and declaring it would have forced a
    // sham case to satisfy the coverage gate.
    expect(CAPABILITY_KEYS).not.toContain("tenantScoping");
    // Every declared capability must be reachable from at least one gated operation, or
    // the coverage gate is unsatisfiable for it. The annotation is the link.
    const repositories = readFileSync(join(storeDir, "repositories.ts"), "utf8");
    for (const key of CAPABILITY_KEYS) {
      expect(repositories, `no operation is gated on ${key}`).toContain(`Capability: \`${key}\``);
    }
  });
});

// ---- the conformance harness ------------------------------------------------

function passingCase(id: string, requires: CapabilityKey | null, answer: unknown = { ok: true, value: 1 }): ConformanceCase {
  return {
    id,
    what: `fixture case ${id}`,
    requires,
    exercise: async () => answer,
    expect: (value) => {
      expect(value).toEqual(answer);
    },
  };
}

describe("conformance harness", () => {
  it("covers every declared capability, with no case left uncovered", () => {
    // THE GATE, now satisfied. Cases arrive with the implementations they describe,
    // and the first implementation may not land while any declared capability has no
    // case — an unexercised capability is where a refusal quietly degenerates into
    // "returns nothing". This assertion is the successor to the one that pinned the
    // list EMPTY, and it is strictly stronger: the gap list must now be empty rather
    // than complete.
    expect(capabilityCoverageGaps()).toEqual([]);
    // THE EXACT LIST, not a floor. A `>=` floor is not a pin: with 48 cases declared, a
    // floor of 30 lets eighteen be deleted with this test still green — and the
    // assertion this one replaced (`CONFORMANCE_CASES` is empty) WAS exact, so a floor
    // would have been a loss of precision at the moment the list started mattering.
    // Adding a case means adding a line here, which is the visible diff the seam's
    // index.ts asks for from every other addition.
    expect(CONFORMANCE_CASES.map((testCase) => testCase.id).sort()).toEqual([
      "address-lifecycle/ownership-patch-round-trip",
      "address-lifecycle/quota-write-round-trip",
      "address-lifecycle/suspend-then-activate-round-trip",
      "addresses/create-then-read-back",
      "addresses/delete-removes-the-row",
      "addresses/list-includes-the-created-row",
      "addresses/quota-clear-is-not-a-no-op",
      "attachments/content-lookup-answers-with-the-stored-bytes",
      "attachments/inventory-scan-emits-every-attachment-exactly-once",
      "attachments/metadata-batch-reports-content-availability",
      "domains/create-then-read-back",
      "domains/delete-removes-the-row",
      "domains/list-includes-the-created-row",
      "domains/lookup-by-name-finds-the-created-row",
      "domains/update-then-read-back",
      "inbound/archive-flag-round-trip",
      "inbound/clear-removes-scoped-mail",
      "inbound/folder-scope-moves-with-the-archive-flag",
      "inbound/label-add-and-remove-round-trip",
      "inbound/read-flag-round-trip",
      "inbound/starred-flag-round-trip",
      "inbound/unread-count-follows-the-read-flag",
      "mailboxes/a-registered-address-rolls-up-its-inbound-mail",
      "messages/counts-follow-the-writes",
      "messages/counts-scope-to-a-recipient-domain",
      "messages/create-then-read-back",
      "messages/delete-removes-the-row",
      "messages/keyset-scan-emits-every-row-exactly-once",
      "messages/keyset-scan-is-exact-once-across-a-write-during-the-scan",
      "messages/list-filters-narrow-to-the-written-message",
      "messages/raw-mime-carries-the-written-headers",
      "messages/resolve-id-answers-not-found-for-an-unknown-id",
      "messages/status-patch-round-trip",
      "messages/upsert-is-idempotent-on-source-id",
      "policy/a-suspended-sender-is-not-allowed",
      "policy/a-zero-quota-address-is-not-sendable",
      "policy/owner-authorization-follows-the-ownership-write",
      "provisioning/address-patch-round-trip",
      "provisioning/domain-patch-round-trip",
      "provisioning/event-recorded-then-listed",
      "repair/a-created-run-reads-back-by-its-id",
      "resources/uniform-crud-round-trip",
      "send-intents/cancel-tombstones-the-key",
      "send-intents/claim-then-complete-records-the-provider-id",
      "send-intents/reserve-is-visible-through-the-key",
      "send-intents/uncertain-intent-is-listed-until-it-is-reconciled",
      "send-keys/mint-then-verify-then-revoke",
      "threads/a-reply-rolls-up-with-its-parent-subject",
    ]);
    const ids = CONFORMANCE_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of CONFORMANCE_CASES) {
      expect(testCase.what.length, `${testCase.id} has no behavioural statement`).toBeGreaterThan(20);
      expect(typeof testCase.exercise, `${testCase.id} has no exercise`).toBe("function");
      expect(typeof testCase.expect, `${testCase.id} has no expectation`).toBe("function");
    }
    // Both kinds of case must be present. A suite that is all-ungated never observes a
    // refusal; a suite that is all-gated never observes ordinary behaviour.
    expect(CONFORMANCE_CASES.filter((testCase) => testCase.requires === null).length).toBeGreaterThan(0);
    expect(CONFORMANCE_CASES.filter((testCase) => testCase.requires !== null).length).toBeGreaterThan(0);
    // And the gap function itself still works, proved against fixtures rather than
    // against repo content, so it keeps working once the real list is complete.
    expect(capabilityCoverageGaps([])).toEqual([...CAPABILITY_KEYS]);
    expect(capabilityCoverageGaps([passingCase("c1", "rawMessage")])).not.toContain("rawMessage");
  });

  it("runs every case against every implementation", async () => {
    const cases = [passingCase("a", null), passingCase("b", "rawMessage"), passingCase("c", "mailRollups")];
    const stores = [fixtureStore("sqlite", capabilities()), fixtureStore("api", capabilities())];
    const report = await runConformanceSuite(stores, cases);
    expect(report.map((entry) => entry.store)).toEqual(["sqlite", "api"]);
    for (const entry of report) expect(entry.results.map((result) => result.caseId)).toEqual(["a", "b", "c"]);
    expect(conformanceFailures(report)).toEqual([]);
    expect(() => assertUniformCaseCoverage(report, cases)).not.toThrow();
  });

  it("counts a refusal as a pass when the capability is declared false", async () => {
    const cases = [
      {
        ...passingCase("raw", "rawMessage"),
        exercise: async (store: EmailStore) => capabilityRefusal("rawMessage", store.descriptor.kind),
      },
    ];
    const report = await runConformanceSuite([fixtureStore("sqlite", capabilities({ rawMessage: false }))], cases);
    expect(report[0]?.results).toEqual([{ caseId: "raw", status: "refused", detail: null }]);
    expect(conformanceFailures(report)).toEqual([]);
  });

  it("fails a store that answers an unavailable capability with an empty value", async () => {
    // The anti-stub proof. `{ ok: true, value: [] }` is exactly what the weaker arm
    // returns today instead of admitting it cannot do the thing, and under this harness
    // it is a FAILURE rather than a green case that happened to return nothing.
    const cases = [passingCase("rollups", "mailRollups", { ok: true, value: [] })];
    const report = await runConformanceSuite([fixtureStore("sqlite", capabilities({ mailRollups: false }))], cases);
    expect(report[0]?.results[0]?.status).toBe("failed");
    expect(conformanceFailures(report)[0]).toContain("did not return the capability refusal");
    // Coverage is still uniform — the case RAN and failed, rather than being skipped.
    expect(() => assertUniformCaseCoverage(report, cases)).not.toThrow();
  });

  it("records a throwing case as failed without losing coverage", async () => {
    const cases = [
      { ...passingCase("boom", null), exercise: async () => { throw new Error("kaboom"); } },
      passingCase("fine", null),
    ];
    const report = await runConformanceSuite([fixtureStore("sqlite", capabilities())], cases);
    expect(report[0]?.results.map((result) => result.status)).toEqual(["failed", "passed"]);
    expect(conformanceFailures(report)).toEqual(["sqlite/boom: Error: kaboom"]);
    expect(() => assertUniformCaseCoverage(report, cases)).not.toThrow();
  });

  it("fails a store that refuses a capability it declares available", async () => {
    // The other direction, which an earlier version reported as a PASS because the
    // refusal was simply handed to `expect`. A declaration that does not match behaviour
    // is a bug whichever way round it points.
    const cases = [
      {
        ...passingCase("raw", "rawMessage"),
        exercise: async (store: EmailStore) => capabilityRefusal("rawMessage", store.descriptor.kind),
      },
    ];
    const report = await runConformanceSuite([fixtureStore("api", capabilities())], cases);
    expect(report[0]?.results[0]?.status).toBe("failed");
    expect(conformanceFailures(report)[0]).toContain("declares rawMessage available but refused");
  });

  it("fails a store whose refusal names a different capability", async () => {
    const cases = [
      {
        ...passingCase("rollups", "mailRollups"),
        exercise: async (store: EmailStore) => capabilityRefusal("rawMessage", store.descriptor.kind),
      },
    ];
    const report = await runConformanceSuite([fixtureStore("sqlite", capabilities({ mailRollups: false }))], cases);
    expect(report[0]?.results[0]?.status).toBe("failed");
  });

  it("cannot be reduced to fewer cases by a case that mutates the list", async () => {
    // The exported case array is frozen AND snapshotted at the start of the run. Before
    // both, a `cases.length = 1` inside the first case made every store execute one case
    // of three while the coverage assertion — reading the mutated array — stayed green.
    const cases: ConformanceCase[] = [passingCase("a", null), passingCase("b", null), passingCase("c", null)];
    cases[0] = {
      ...passingCase("a", null),
      exercise: async () => {
        cases.length = 1;
        return { ok: true, value: 1 };
      },
    };
    const report = await runConformanceSuite([fixtureStore("sqlite", capabilities())], cases);
    expect(report[0]?.results.map((result) => result.caseId)).toEqual(["a", "b", "c"]);
    expect(() => Object.assign(CONFORMANCE_CASES as unknown as unknown[], { length: 0 })).toThrow();
  });

  it("does not accept the same store twice as two implementations", () => {
    const cases = [passingCase("a", null)];
    const twice: ConformanceReport = [
      { store: "sqlite", results: [{ caseId: "a", status: "passed", detail: null }] },
      { store: "sqlite", results: [{ caseId: "a", status: "passed", detail: null }] },
    ];
    expect(() => assertUniformCaseCoverage(twice, cases)).toThrow(/same store more than once/);
  });

  it("fails when one implementation executed fewer cases than another", () => {
    const cases = [passingCase("a", null), passingCase("b", null)];
    const uneven: ConformanceReport = [
      { store: "api", results: [{ caseId: "a", status: "passed", detail: null }, { caseId: "b", status: "passed", detail: null }] },
      { store: "sqlite", results: [{ caseId: "a", status: "passed", detail: null }] },
    ];
    expect(() => assertUniformCaseCoverage(uneven, cases)).toThrow(
      /sqlite executed 1 of 2 conformance cases; missing: b/,
    );
  });

  it("refuses to certify an empty run", () => {
    // A coverage assertion over zero cases or zero stores passes trivially. This repo
    // has already shipped two guards that certified nothing that way, so an empty run
    // throws instead.
    expect(() => assertUniformCaseCoverage([], [])).toThrow(/no cases/);
    expect(() => assertUniformCaseCoverage([], [passingCase("a", null)])).toThrow(/no implementations/);
  });

  it("rejects duplicate case ids", () => {
    const cases = [passingCase("dup", null), passingCase("dup", null)];
    const report: ConformanceReport = [
      { store: "sqlite", results: [{ caseId: "dup", status: "passed", detail: null }, { caseId: "dup", status: "passed", detail: null }] },
    ];
    expect(() => assertUniformCaseCoverage(report, cases)).toThrow(/must be unique; duplicated: dup/);
  });
});
