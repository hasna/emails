import type { DnsRecord, DnsStatus, Provider, SendEmailOptions, Stats } from "../types/index.js";
import type { ProviderAdapter, RemoteAddress, RemoteDomain, RemoteEvent } from "./interface.js";
import { storeSandboxEmail, getSandboxCount } from "../db/sandbox.js";

export class SandboxAdapter implements ProviderAdapter {
  constructor(private provider: Provider) {}

  async listDomains(): Promise<RemoteDomain[]> {
    return [];
  }

  async getDnsRecords(_domain: string): Promise<DnsRecord[]> {
    return [];
  }

  async verifyDomain(_domain: string): Promise<{ dkim: DnsStatus; spf: DnsStatus; dmarc: DnsStatus }> {
    return { dkim: "pending" as DnsStatus, spf: "pending" as DnsStatus, dmarc: "pending" as DnsStatus };
  }

  async addDomain(_domain: string): Promise<void> {
    // no-op for sandbox
  }

  async listAddresses(): Promise<RemoteAddress[]> {
    return [];
  }

  async addAddress(_email: string): Promise<void> {
    // no-op for sandbox
  }

  async verifyAddress(_email: string): Promise<boolean> {
    return true;
  }

  async sendEmail(opts: SendEmailOptions): Promise<string> {
    const email = await storeSandboxEmail(
      {
        provider_id: this.provider.id,
        from_address: opts.from,
        to_addresses: Array.isArray(opts.to) ? opts.to : [opts.to],
        cc_addresses: opts.cc ? (Array.isArray(opts.cc) ? opts.cc : [opts.cc]) : [],
        bcc_addresses: opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc : [opts.bcc]) : [],
        reply_to: opts.reply_to ?? null,
        subject: opts.subject,
        html: opts.html ?? null,
        text_body: opts.text ?? null,
        attachments: opts.attachments ?? [],
        headers: {},
      },
    );
    const toStr = Array.isArray(opts.to) ? opts.to.join(", ") : opts.to;
    if (process.env["EMAILS_JSON_OUTPUT"] !== "1") {
      process.stderr.write(`\n[sandbox] Email captured: ${opts.subject} → ${toStr} (id: ${email.id})\n`);
    }
    return email.id;
  }

  async pullEvents(_since?: string): Promise<RemoteEvent[]> {
    return [];
  }

  async getStats(_period?: string): Promise<Stats> {
    const count = await getSandboxCount(this.provider.id);
    // `null` MEANS "NOT A TOTAL", AND `Stats` HAS NOWHERE TO SAY SO. Every field on `Stats`
    // (src/types/index.ts) is a plain `number` — it is the shape four provider adapters
    // return, and it carries no availability or completeness marker — so a lower bound
    // written into `sent` would be read as a total by everything downstream, and a `0`
    // would report a full sandbox as an empty one. Both are the fabricated value this
    // family's collapse removes, so the only honest answer left is to fail loudly.
    //
    // Reachable whenever the capture table could not be enumerated to its end. That is NOT
    // only a scale limit: the 200-page budget is one cause, and a row inserted or deleted
    // between two pages is the other, which adversarial review measured at three rows. A store
    // REFUSAL or a transport fault already throws out of `getSandboxCount` itself.
    if (count === null) {
      throw new Error(
        `Sandbox provider ${this.provider.id}: the captured emails could not be counted to the end of the `
          + "table, so this figure would be a lower bound rather than a total. Refusing to report it as one; "
          + "clear the capture table or narrow the provider.",
      );
    }
    return {
      provider_id: this.provider.id,
      period: "all",
      sent: count,
      delivered: count,
      bounced: 0,
      complained: 0,
      opened: 0,
      clicked: 0,
      delivery_rate: 100,
      bounce_rate: 0,
      open_rate: 0,
    };
  }
}
