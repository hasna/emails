import { describe, expect, it } from "bun:test";
import { EmailsSelfHostClient } from "./selfhost.js";

describe("EmailsSelfHostClient transport policy", () => {
  it("accepts HTTPS and loopback HTTP", () => {
    expect(() => new EmailsSelfHostClient({ baseUrl: "https://emails.example" })).not.toThrow();
    expect(() => new EmailsSelfHostClient({ baseUrl: "http://localhost:8080" })).not.toThrow();
    expect(() => new EmailsSelfHostClient({ baseUrl: "http://127.0.0.1:8080" })).not.toThrow();
    expect(() => new EmailsSelfHostClient({ baseUrl: "http://[::1]:8080" })).not.toThrow();
  });

  it("rejects plaintext remote and malformed URLs before retaining credentials", () => {
    expect(() => new EmailsSelfHostClient({ baseUrl: "http://emails.example", apiKey: "must-not-appear" }))
      .toThrow(/requires HTTPS/);
    expect(() => new EmailsSelfHostClient({ baseUrl: "not-a-url" })).toThrow();
  });
});
