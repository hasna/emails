import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { setLogLevel, log } from "./logger.js";

let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  setLogLevel(false, false); // reset
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("setLogLevel", () => {
  it("defaults to not quiet and not verbose", () => {
    log.info("hello");
    log.debug("debug msg");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1); // info yes, debug no
  });
});

describe("log.info", () => {
  it("logs when not quiet", () => {
    setLogLevel(false, false);
    log.info("test message");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it("suppressed when quiet", () => {
    setLogLevel(true, false);
    log.info("test message");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

describe("log.debug", () => {
  it("suppressed by default", () => {
    setLogLevel(false, false);
    log.debug("debug msg");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("logs when verbose", () => {
    setLogLevel(false, true);
    log.debug("debug msg");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });
});

describe("log.error", () => {
  it("always logs to stderr", () => {
    setLogLevel(true, false);
    log.error("error msg");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs even when quiet", () => {
    setLogLevel(true, false);
    log.error("err");
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("log.success", () => {
  it("logs when not quiet", () => {
    setLogLevel(false, false);
    log.success("ok");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it("suppressed when quiet", () => {
    setLogLevel(true, false);
    log.success("ok");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

describe("log.warn", () => {
  it("logs when not quiet", () => {
    setLogLevel(false, false);
    log.warn("warning");
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it("suppressed when quiet", () => {
    setLogLevel(true, false);
    log.warn("warning");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});
