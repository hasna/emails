# Email-address provisioning (open-emails)

Give users and agents **real email addresses on domains we own**, fully
automatically: buy the domain, wire DNS through Cloudflare, set up SES sending +
receiving, create addresses, and verify by sending mail back and forth.

## One command
```
emails provision domain ours.com --provider <ses-id> --add-mx   # SES identity + publish DNS in Cloudflare
emails provision address andrew@ours.com --provider <ses-id> --receive ses-s3
emails provision status
```
For buying + delegating first, use `@hasna/domains` (`domains domain buy <name> --wait --dns cloudflare`) or the `setup_domain_for_email` MCP tool (which now buys, creates the Cloudflare zone, delegates NS, registers with SES, and publishes DNS **in Cloudflare**).

## The pipeline
1. **Buy** (Route53, `@hasna/domains`) — the only reliable self-serve API.
2. **DNS → always Cloudflare** — create the zone, delegate registrar NS to it.
3. **Send** — SES domain identity (any `*@domain` can send); Resend secondary.
4. **Receive** — one of three strategies (none are IMAP mailboxes):
   - `ses-s3` (default): SES receipt rule → S3 → `emails inbox sync-s3` → SQLite. **The real mailbox.**
   - `cf-routing`: Cloudflare Email Routing forward/Worker (no stored body unless a Worker persists it).
   - `resend-webhook`: Resend `email.received` webhook (no mailbox; body fetched via API).
5. **Validate** — `emails test roundtrip` sends tokened mail back and forth and confirms receipt.

## There is no IMAP/POP mailbox anywhere
No provider (SES, Cloudflare, Resend) exposes an IMAP/POP inbox. **Our SQLite + S3
IS the mailbox** for the `ses-s3` strategy: SES drops raw MIME into S3, and
`emails inbox sync-s3` parses it into the local `inbound_emails` table. Don't
expect "direct mailbox access" — query the synced store instead.

## State machine + daemon
Domains and addresses move through an explicit, resumable lifecycle
(`src/lib/provision/state-machine.ts`); the reconciler daemon
(`src/daemon/provisioner.ts`) advances any entity whose `next_check_at` is due,
crash-safe because all state lives in the DB.

## Credentials (`emails doctor`)
- **AWS** (SES send/inbound, Route53 buy): `AWS_PROFILE` or keys, region us-east-1.
- **Cloudflare** (DNS + Email Routing): `CLOUDFLARE_API_TOKEN` *or*
  `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` (vault `HASNAXYZ_CLOUDFLARE_LIVE_*`) +
  `CLOUDFLARE_ACCOUNT_ID`.
- **Resend** (optional): `RESEND_API_KEY`.
- **SES sandbox**: new accounts send only to verified identities (200/day, 1/sec);
  request production access with the `ses-sandbox` helper (PutAccountDetails).

## Proven live
Verified end-to-end: 3 funny `.com` domains bought, DNS in Cloudflare, SES DKIM
verified, 3 addresses/domain, **144/144 emails** sent via the `emails` CLI and
received (SES→S3→SQLite). See `docs/PLAN-PROVISIONING.md` for the architecture.
