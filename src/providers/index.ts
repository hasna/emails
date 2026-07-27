import type { DnsPublishingSupport, DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import { ProviderConfigError } from "../types/index.js";
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
 * Lives here, next to `assertProviderConfig()` and `getAdapter()`, because this
 * file is already the one place that decides anything from `ProviderType` — the
 * alternative is a `provider.type === "sandbox"` test at every surface that
 * renders records, which is exactly the drift this answers once.
 *
 * The switch is exhaustive and the default throws, so adding a provider type
 * forces an explicit answer here rather than silently inheriting "publishes".
 * That direction matters: inheriting the wrong default would print DNS advice
 * for a provider that has none, or bury a real empty result.
 *
 * Reading it needs no credentials and does not load an adapter, so it is safe on
 * a path that only formats output.
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
          + "DNS-authenticated sender, so a domain on one has no DKIM, SPF or DMARC of its own",
        instead:
          "Nothing is missing and nothing needs publishing. Move the domain to an SES or Resend "
          + "provider when you want records to publish.",
      };
    default:
      throw new ProviderConfigError(
        `Unknown provider type: ${(provider as { type?: unknown }).type}. `
          + "Declare whether it publishes DNS records in providerDnsPublishing().",
      );
  }
}

export function getAdapter(provider: Provider): ProviderAdapter {
  assertProviderConfig(provider);
  switch (provider.type) {
    case "resend":
      return new LazyProviderAdapter(async () => {
        const { ResendAdapter } = await import("./resend.js");
        return new ResendAdapter(provider);
      });
    case "ses":
      return new LazyProviderAdapter(async () => {
        const { SESAdapter } = await import("./ses.js");
        return new SESAdapter(provider);
      }, { supportsMailFrom: true, supportsDomainVerification: true });
    case "sandbox":
      return new LazyProviderAdapter(async () => {
        const { SandboxAdapter } = await import("./sandbox.js");
        return new SandboxAdapter(provider);
      });
    default:
      throw new ProviderConfigError(`Unknown provider type: ${provider.type}`);
  }
}

export type { ProviderAdapter, RemoteDomain, RemoteAddress, RemoteEvent } from "./interface.js";
