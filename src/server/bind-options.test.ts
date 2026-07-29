import { describe, expect, it } from "bun:test";
import { resolveServerBindOptions } from "./bind-options.js";

describe("emails-serve bind options", () => {
  it("gives CLI flags precedence over HOST and PORT", () => {
    expect(resolveServerBindOptions(
      ["--host", "127.0.0.1", "--port", "4100"],
      { HOST: "0.0.0.0", PORT: "4200" },
      "sqlite",
    )).toEqual({ host: "127.0.0.1", port: 4100 });
  });

  it("preserves HOST and PORT when flags are absent", () => {
    expect(resolveServerBindOptions([], { HOST: "localhost", PORT: "4300" }, "sqlite"))
      .toEqual({ host: "localhost", port: 4300 });
  });

  it("uses backend-specific defaults after flags and environment", () => {
    expect(resolveServerBindOptions([], {}, "sqlite"))
      .toEqual({ host: "127.0.0.1", port: 3900 });
    expect(resolveServerBindOptions([], {}, "postgresql"))
      .toEqual({ host: "0.0.0.0", port: 8080 });
  });

  it("accepts inline flag values and rejects invalid ports", () => {
    expect(resolveServerBindOptions(["--host=localhost", "--port=4400"], {}, "sqlite"))
      .toEqual({ host: "localhost", port: 4400 });
    expect(() => resolveServerBindOptions(["--port", "not-a-port"], {}, "sqlite"))
      .toThrow("--port must be an integer between 0 and 65535");
    for (const ambiguous of [" ", "+2", "1e3", "0x10"]) {
      expect(() => resolveServerBindOptions(["--port", ambiguous], {}, "sqlite"))
        .toThrow("--port must be an integer between 0 and 65535");
    }
    expect(() => resolveServerBindOptions([], { PORT: " " }, "sqlite"))
      .toThrow("PORT must be an integer between 0 and 65535");
  });

  it("uses the last value when host or port flags are repeated", () => {
    expect(resolveServerBindOptions([
      "--host", "first.example",
      "--port", "4100",
      "--host=last.example",
      "--port=4200",
    ], {}, "sqlite")).toEqual({ host: "last.example", port: 4200 });
  });

  it("rejects missing separate values and empty inline values", () => {
    for (const args of [["--host"], ["--host="]]) {
      expect(() => resolveServerBindOptions(args, {}, "sqlite"))
        .toThrow("--host requires a value");
    }
    for (const args of [["--port"], ["--port="]]) {
      expect(() => resolveServerBindOptions(args, {}, "sqlite"))
        .toThrow("--port requires a value");
    }
  });

  it("accepts exact port boundaries and rejects values above the maximum", () => {
    for (const accepted of ["0", "65535"]) {
      expect(resolveServerBindOptions(["--port", accepted], {}, "sqlite").port)
        .toBe(Number(accepted));
      expect(resolveServerBindOptions([], { PORT: accepted }, "sqlite").port)
        .toBe(Number(accepted));
    }
    expect(() => resolveServerBindOptions(["--port", "65536"], {}, "sqlite"))
      .toThrow("--port must be an integer between 0 and 65535");
    expect(() => resolveServerBindOptions([], { PORT: "65536" }, "sqlite"))
      .toThrow("PORT must be an integer between 0 and 65535");
  });
});
