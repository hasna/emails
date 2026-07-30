// Shared @aws-sdk/client-sts mock for the test suite.
//
// Same design and same reason as src/test-support/aws-s3-mock.ts (see that
// module's header): bun's `mock.module` is PROCESS-GLOBAL and a module namespace
// is cached at its FIRST dynamic import, so every test file that needs the STS
// SDK mocked must share ONE registered namespace whose `send` delegates to a
// mutable per-test handler. Source paths that reach STS at test time:
// src/lib/aws-inbound.ts (account-id lookup for the bucket policy condition),
// src/cli/commands/domain.ts (`adopt`'s default-bucket resolution), and
// src/lib/inbound-chain.ts (the provisioning preflight).
//
// The DEFAULT handler THROWS, mirroring what the real SDK does in the scrubbed
// hermetic test environment (no credentials, instance metadata disabled): callers
// that tolerate a failed STS lookup (aws-inbound.ts catches and omits the policy
// condition) keep today's behavior, and callers that must refuse without
// credentials (the preflight) see the failure they are specified against. No
// secret is ever logged; this is test scaffolding only.

import { mock } from "bun:test";

export interface StsCommand {
  /** Command name without the "Command" suffix, e.g. "GetCallerIdentity". */
  __type: string;
  input: Record<string, unknown>;
}

export type StsSendHandler = (cmd: StsCommand) => unknown | Promise<unknown>;

const defaultHandler: StsSendHandler = () => {
  throw new Error("STS is not reachable from the test environment (shared aws-sts-mock default)");
};
let handler: StsSendHandler = defaultHandler;

/** Set the STS `send` behavior for the current test. Call in `beforeEach`. */
export function setStsSendHandler(next: StsSendHandler): void {
  handler = next;
}

/** Restore the default handler (throws, like the credential-less real SDK). */
export function resetStsSendHandler(): void {
  handler = defaultHandler;
}

function makeCommand(name: string): new (input?: Record<string, unknown>) => StsCommand {
  const type = name.replace(/Command$/, "");
  const holder = {
    [name]: class {
      input: Record<string, unknown>;
      __type = type;
      constructor(input: Record<string, unknown> = {}) {
        this.input = input;
      }
    },
  };
  return holder[name] as unknown as new (input?: Record<string, unknown>) => StsCommand;
}

function buildModule(): Record<string, unknown> {
  return {
    STSClient: class {
      async send(cmd: StsCommand): Promise<unknown> {
        return handler(cmd);
      }
    },
    GetCallerIdentityCommand: makeCommand("GetCallerIdentityCommand"),
  };
}

// Register the shared namespace as soon as this module is imported by any test
// file. Idempotent across importers (same factory, identical shape).
mock.module("@aws-sdk/client-sts", buildModule);
