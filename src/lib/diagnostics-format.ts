import { ansi } from "./ansi.js";

export interface DoctorCheck {
  name: string;
  /**
   * `unknown` is the fourth value, and it is here because the other three are all CLAIMS
   * ABOUT THE SYSTEM and none of them can say "I could not look".
   *
   * A diagnostic that reads its facts through the store seam (src/lib/doctor.ts) has
   * subjects it genuinely cannot observe: a capability the store declares unavailable, a
   * count whose page filled so the total is only a lower bound, credential columns the
   * seam redacts by contract. With a three-value status the only ways to emit those were
   * to pick a comfortable lie \u2014 `pass` carrying a zero, or `fail` for a fact that is not
   * broken \u2014 or to omit the check, which reads as "nothing wrong" and is the worst of the
   * three. This repo has shipped that omission before; see CHANGELOG.md.
   *
   * Widening rather than reusing `warn` is deliberate: `warn` means "this is true and you
   * should know about it", and a caller that counts warnings to decide whether the system
   * is degraded must not have "not measured" folded into that number.
   */
  status: "pass" | "warn" | "fail" | "unknown";
  message: string;
}

export function formatDiagnostics(checks: DoctorCheck[]): string {
  const icons = {
    pass: ansi.green("\u2713"),
    warn: ansi.yellow("\u26A0"),
    fail: ansi.red("\u2717"),
    unknown: ansi.cyan("?"),
  };
  let output = ansi.bold("\n  Email System Diagnostics\n\n");
  for (const check of checks) {
    output += `  ${icons[check.status]} ${check.name}: ${check.message}\n`;
  }
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  output += `\n  ${ansi.bold("Summary:")} ${ansi.green(passed + " passed")}`;
  if (warned) output += ` ${ansi.yellow(warned + " warnings")}`;
  if (failed) output += ` ${ansi.red(failed + " failed")}`;
  // Counted separately and never folded into either of the two above: an unmeasured
  // subject is not a passing one, and it is not a broken one.
  if (unknown) output += ` ${ansi.cyan(unknown + " unknown")}`;
  output += "\n";
  return output;
}
