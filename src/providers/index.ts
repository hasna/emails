import type { DnsPublishingSupport, DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
import { applyDurableCredentials } from "../db/providers.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";

class LazyProviderAdapter implements ProviderAdapter {
  private adapter: ProviderAdapter | null = null;
  setMailFrom?: (domain: string, mailFromDomain?: string) => Promise<string>;
  reinitiateDomainVerification?: (domain: string) => Promise<DnsRecord[]>;

  constructor(private readonly loader: () => Promise<ProviderAdapter>, opts: { supportsMailFrom?: boolean; supportsDomainVerification?: boolean } = {}) {
    if (opts.supportsMailFrom) {
      this.setMailFrom = async (domain: string, mailFromDomain?: string) => {
        const adapter = await this.load();
        if (!adapter.setMailFrom) throw new ProviderConfigError("Provider does not support custom MAIL FROM domains");
        return adapter.setMailFrom(domain, mailFromDomain);
      };
    }
    if (opts.supportsDomainVerification) {
      this.reinitiateDomainVerification = async (domain: string) => {
        const adapter = await this.load();
        if (!adapter.reinitiateDomainVerification) {
          throw new ProviderConfigError("Provider does not support re-initiating domain verification");
        }
        return adapter.reinitiateDomainVerification(domain);
      };
    }
  }

  private async load(): Promise<ProviderAdapter> {
    if (!this.adapter) this.adapter = await this.loader();
    return this.adapter;
  }

  async listDomains(): Promise<RemoteDomain[]> {
    return (await this.load()).listDomains();
  }

  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    return (await this.load()).getDnsRecords(domain);
  }

  async verifyDomain(domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    return (await this.load()).verifyDomain(domain);
  }

  async addDomain(domain: string): Promise<void> {
    return (await this.load()).addDomain(domain);
  }

  async listAddresses(): Promise<RemoteAddress[]> {
    return (await this.load()).listAddresses();
  }

  async addAddress(email: string): Promise<void> {
    return (await this.load()).addAddress(email);
  }

  async verifyAddress(email: string): Promise<boolean> {
    return (await this.load()).verifyAddress(email);
  }

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    return (await this.load()).sendEmail(opts);
  }

  async pullEvents(since?: string): Promise<RemoteEvent[]> {
    return (await this.load()).pullEvents(since);
  }

  async getStats(period?: string): Promise<Stats> {
    return (await this.load()).getStats(period);
  }
}

function assertProviderConfig(provider: Provider): void {
  switch (provider.type) {
    case "resend":
      if (!provider.api_key) throw new ProviderConfigError("Resend provider requires an API key");
      return;
    case "ses":
    case "sandbox":
      return;
    default:
      throw new ProviderConfigError(`Unknown provider type: ${(provider as { type?: unknown }).type}`);
  }
}

/**
 * Whether `provider`'s type publishes DNS records at all.
 *
 * Lives here because this file owns the provider REGISTRY — `assertProviderConfig()`
 * and `getAdapter()` are the two other per-type decisions that every caller
 * inherits rather than restating. (Other files do branch on `provider.type`:
 * `src/lib/send.local.ts`, `src/cli/commands/provider.ts`,
 * `src/mcp/tools/providers-impl.ts`. Each answers a local question. This one is
 * consumed by anything that renders records, so it belongs with the registry.)
 *
 * `const exhaustive: never` is the load-bearing part. A bare `default: throw`
 * defeats TypeScript's exhaustiveness narrowing, and the runtime throw is
 * unreachable from the MCP call site anyway because `getAdapter()` rejects an
 * unknown type first — so without the `never` assignment a new `ProviderType`
 * member would silently inherit nothing and CI would stay green. `**\/*.test.ts`
 * is excluded from `tsconfig.json`, so this guard has to live in product code to
 * be checked at all.
 *
 * Reading this needs no credentials and does not load an adapter, so it is safe
 * on a path that only formats output.
 */
export function providerDnsPublishing(provider: Provider): DnsPublishingSupport {
  switch (provider.type) {
    case "ses":
    case "resend":
      // Both hand mail to infrastructure that authenticates on the sending
      // domain, so both have DKIM/SPF/DMARC for the operator to publish.
      return { publishes: true };
    case "sandbox":
      return {
        publishes: false,
        reason:
          "a sandbox provider captures mail in the local store instead of handing it to a "
          + "DNS-authenticated sender, so a sandbox domain has no DKIM, SPF or DMARC of its own",
        instead:
          "Nothing is missing. To get real records, move the domain to an SES or Resend provider: "
          + "'emails domain move-provider <domain> --to-provider <id>'.",
      };
    default: {
      // Compile-time exhaustiveness. The throw stays as well, because a provider
      // row read out of the database can hold a type outside the union.
      const exhaustive: never = provider.type;
      throw new ProviderConfigError(
        `Unknown provider type: ${String(exhaustive)}. `
          + "Declare whether it publishes DNS records in providerDnsPublishing().",
      );
    }
  }
}

export function getAdapter(provider: Provider): ProviderAdapter {
  // Provider DTOs are credential-free. Unwrap only at the provider execution
  // boundary; candidates used for validation already carry their unsaved
  // credential values and therefore never touch the durable keyring. Only the
  // secret fields are overlaid, so the caller's own provider type still selects
  // the adapter that is built.
  const executable = provider.id && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(provider.id)
    ? applyDurableCredentials(provider)
    : provider;
  assertProviderConfig(executable);
  switch (executable.type) {
    case "resend":
      return new LazyProviderAdapter(async () => {
        const { ResendAdapter } = await import("./resend.js");
        return new ResendAdapter(executable);
      });
    case "ses":
      return new LazyProviderAdapter(async () => {
        const { SESAdapter } = await import("./ses.js");
        return new SESAdapter(executable);
      }, { supportsMailFrom: true, supportsDomainVerification: true });
    case "sandbox":
      return new LazyProviderAdapter(async () => {
        const { SandboxAdapter } = await import("./sandbox.js");
        return new SandboxAdapter(executable);
      });
    default:
      throw new ProviderConfigError(`Unknown provider type: ${executable.type}`);
  }
}

export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./interface.js";
