// `emails auth …` — user accounts, sessions, and tenant-scoped API keys for the
// self-hosted service (multi-tenancy design §5/§7 + Addendum).
//
// Every command is a plain HTTP call to the operator's /v1 API through the
// shared self-hosted transport. The client NEVER sends a tenant — the server
// derives it from the credential. On login/switch-tenant the returned session
// token is persisted to the vault entry behind EMAILS_CLIENT_ENV_SECRET (and the
// in-process env) so subsequent commands are authed. The token is never printed
// or logged.

import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import chalk from "../../lib/chalk-lite.js";
import {
  clearClientEnvSessionToken,
  persistClientEnvSessionToken,
  type SessionTokenPersistResult,
} from "../../lib/client-env.js";
import { resetSelfHostedConfigCache, selfHostedApiRequest } from "../../db/self-hosted-store.js";
import { describeIdentity, fetchIdentity } from "../../lib/whoami.js";
import { handleError } from "../utils.js";

type OutputFn = (data: unknown, formatted: string) => void;

// ── response helpers ────────────────────────────────────────────────────────

function asObject(json: unknown): Record<string, unknown> {
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function fieldString(json: unknown, ...keys: string[]): string | null {
  const obj = asObject(json);
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Best-effort human message from an error response body. */
function bodyError(json: unknown, fallback: string): string {
  return fieldString(json, "error", "message", "reason", "detail") ?? fallback;
}

function bodyReason(json: unknown): string | null {
  return fieldString(json, "reason", "code", "error");
}

function tenantLabel(json: unknown): string {
  const tenant = asObject(json)["tenant"];
  return fieldString(tenant, "slug", "name") ?? "your org";
}

// ── interactive prompts (options win; TTY-only fallback) ────────────────────

async function promptText(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${question.replace(/[:\s]+$/, "")} is required (non-interactive: pass it as an option).`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// Read a secret without echoing it. Raw-mode char reader (no readline internals).
async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${question.replace(/[:\s]+$/, "")} is required (non-interactive: pass it as an option).`);
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r" || code === 4) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (code === 127 || code === 8) value = value.slice(0, -1);
        else if (code >= 0x20) value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function resolveEmail(optionValue: string | undefined): Promise<string> {
  const value = optionValue?.trim();
  return value || (await promptText("Email: "));
}

async function resolvePassword(optionValue: string | undefined): Promise<string> {
  const value = optionValue?.trim();
  return value || (await promptHidden("Password: "));
}

function persistenceNote(result: SessionTokenPersistResult): string {
  return result.scope === "vault"
    ? chalk.dim("Session saved to the EMAILS_CLIENT_ENV_SECRET vault entry.")
    : chalk.yellow(
        "Session set for this process only. Set EMAILS_CLIENT_ENV_SECRET to persist it across commands.",
      );
}

// ── auth flows ──────────────────────────────────────────────────────────────

function handleSignup(output: OutputFn) {
  return async (opts: {
    email?: string;
    password?: string;
    name?: string;
    tenantName?: string;
    tenantSlug?: string;
  }) => {
    try {
      const email = await resolveEmail(opts.email);
      const password = await resolvePassword(opts.password);
      const tenantName = opts.tenantName?.trim() || (await promptText("Organization name: "));
      const body: Record<string, unknown> = { email, password, tenant_name: tenantName };
      if (opts.name?.trim()) body["name"] = opts.name.trim();
      if (opts.tenantSlug?.trim()) body["tenant_slug"] = opts.tenantSlug.trim();

      const { status, json } = selfHostedApiRequest("POST", "/auth/signup", body, { requireCredential: false });
      if (status === 403) {
        return handleError(new Error("Signup is restricted to @hasna.<tld> email addresses."));
      }
      if (status === 409) {
        // The server dedupes an existing EMAIL silently (generic 200), so a 409 here
        // is a tenant SLUG collision — surface that, not a false "account exists".
        if (bodyReason(json) === "slug_taken") {
          return handleError(new Error("That organization slug is already taken. Choose another with --tenant-slug."));
        }
        return handleError(new Error(bodyError(json, `An organization with those details already exists.`)));
      }
      if (status < 200 || status >= 300) {
        return handleError(new Error(bodyError(json, `Signup failed (HTTP ${status}).`)));
      }
      const org = tenantLabel(json) || tenantName;
      const lines = [
        chalk.green(`✓ Account created for ${email} in ${org}.`),
        chalk.yellow("Check your inbox for a verification link."),
        chalk.dim("Complete it with:  emails auth verify-email <token>"),
        chalk.dim(`Resend it with:    emails auth verify-email --resend --email ${email}`),
      ];
      output(
        {
          created: true,
          verification_required: true,
          user: asObject(json)["user"] ?? { email },
          tenant: asObject(json)["tenant"] ?? { name: tenantName },
        },
        lines.join("\n"),
      );
    } catch (error) {
      handleError(error);
    }
  };
}

function loginSuccess(output: OutputFn, json: unknown): void {
  const token = fieldString(json, "session_token", "token");
  if (!token) {
    return handleError(new Error("Login response did not include a session token."));
  }
  const persist = persistClientEnvSessionToken(token);
  resetSelfHostedConfigCache();
  const email = fieldString(asObject(json)["user"], "email") ?? "you";
  const org = tenantLabel(json);
  const role = fieldString(json, "role") ?? fieldString(asObject(json)["membership"], "role");
  const summary = role
    ? `✓ Signed in as ${email} — ${org} (${role})`
    : `✓ Signed in as ${email} — ${org}`;
  output(
    {
      logged_in: true,
      user: asObject(json)["user"] ?? { email },
      tenant: asObject(json)["tenant"] ?? { slug: org },
      role,
      persisted: persist.scope,
    },
    `${chalk.green(summary)}\n${persistenceNote(persist)}`,
  );
}

function handleLogin(output: OutputFn) {
  return async (opts: { email?: string; password?: string; tenant?: string }) => {
    try {
      const email = await resolveEmail(opts.email);
      const password = await resolvePassword(opts.password);
      let tenantSlug = opts.tenant?.trim() || undefined;

      // Up to two attempts: the first may return needs_tenant → choose one → retry.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body: Record<string, unknown> = { email, password };
        if (tenantSlug) body["tenant_slug"] = tenantSlug;
        const { status, json } = selfHostedApiRequest("POST", "/auth/login", body, { requireCredential: false });

        if (status === 401) return handleError(new Error("Invalid email or password."));
        if (status === 429) {
          const retry = Number(asObject(json)["retry_after"]);
          const when = Number.isFinite(retry) && retry > 0 ? ` in ${retry}s` : " in a little while";
          return handleError(new Error(`Too many attempts. Try again${when}.`));
        }
        if (status === 403) {
          // Server 403 reasons: email_unverified / email_not_allowed / no_tenant / not_a_member.
          const reason = bodyReason(json);
          if (reason && /verif/i.test(reason)) {
            return handleError(
              new Error(
                `Your email isn't verified yet. Check your inbox, or run: emails auth verify-email --resend --email ${email}`,
              ),
            );
          }
          if (reason === "no_tenant") {
            return handleError(
              new Error("Your account isn't a member of any organization yet. Ask an owner or admin for an invite."),
            );
          }
          if (reason === "not_a_member") {
            return handleError(new Error("You're not a member of that organization."));
          }
          return handleError(new Error("Sign-in is restricted to @hasna.<tld> email addresses."));
        }
        if (status < 200 || status >= 300) {
          return handleError(new Error(bodyError(json, `Login failed (HTTP ${status}).`)));
        }

        const obj = asObject(json);
        if (obj["verification_required"] === true && !fieldString(json, "session_token", "token")) {
          return handleError(
            new Error(
              `Your email isn't verified yet. Check your inbox, or run: emails auth verify-email --resend --email ${email}`,
            ),
          );
        }
        if (obj["needs_tenant"] === true) {
          const tenants = Array.isArray(obj["tenants"]) ? (obj["tenants"] as unknown[]) : [];
          const choices = tenants.map((t) => ({
            slug: fieldString(t, "slug") ?? "",
            name: fieldString(t, "name") ?? "",
            role: fieldString(t, "role") ?? "",
          })).filter((c) => c.slug);
          if (attempt === 0 && (process.stdin.isTTY && process.stdout.isTTY)) {
            const list = choices
              .map((c, i) => `  ${i + 1}. ${c.slug}${c.name ? ` (${c.name})` : ""}${c.role ? ` — ${c.role}` : ""}`)
              .join("\n");
            const answer = await promptText(`You belong to multiple orgs:\n${list}\nChoose a slug: `);
            tenantSlug = answer.trim();
            continue;
          }
          const slugs = choices.map((c) => c.slug).join(", ");
          return handleError(
            new Error(`You belong to multiple orgs. Re-run with --tenant <slug>. Available: ${slugs}`),
          );
        }
        return loginSuccess(output, json);
      }
      handleError(new Error("Could not select an organization to sign in to."));
    } catch (error) {
      handleError(error);
    }
  };
}

function handleLogout(output: OutputFn) {
  return async () => {
    try {
      // Best-effort server-side revoke; the local session is cleared regardless.
      try {
        selfHostedApiRequest("POST", "/auth/logout");
      } catch {
        // ignore — proceed to clear the local session
      }
      const cleared = clearClientEnvSessionToken();
      resetSelfHostedConfigCache();
      output(
        { logged_out: true, cleared: cleared.scope },
        chalk.green("✓ Signed out."),
      );
    } catch (error) {
      handleError(error);
    }
  };
}

function handleWhoami(output: OutputFn) {
  return async () => {
    try {
      const result = fetchIdentity();
      if (!result.ok) {
        if (result.status === 401) {
          return handleError(new Error("Not signed in. Run: emails auth login"));
        }
        return handleError(new Error(result.error));
      }
      const id = result.identity;
      const lines = [chalk.bold(describeIdentity(id))];
      if (id.user?.email) lines.push(chalk.dim(`user:   ${id.user.email}${id.user.name ? ` (${id.user.name})` : ""}`));
      if (id.tenant) lines.push(chalk.dim(`org:    ${id.tenant.slug ?? id.tenant.name ?? id.tenant.id ?? "?"}`));
      if (id.role) lines.push(chalk.dim(`role:   ${id.role}`));
      if (id.scopes.length) lines.push(chalk.dim(`scopes: ${id.scopes.join(", ")}`));
      if (id.memberships.length > 1) {
        lines.push(chalk.dim(`orgs:   ${id.memberships.map((m) => m.tenant.slug ?? m.tenant.name).filter(Boolean).join(", ")}`));
      }
      output(id, lines.join("\n"));
    } catch (error) {
      handleError(error);
    }
  };
}

function handleSwitchTenant(output: OutputFn) {
  return async (slug: string) => {
    try {
      const tenantSlug = slug.trim();
      if (!tenantSlug) return handleError(new Error("A tenant slug is required."));
      const { status, json } = selfHostedApiRequest("POST", "/auth/switch-tenant", { tenant_slug: tenantSlug });
      if (status === 401) return handleError(new Error("Not signed in. Run: emails auth login"));
      if (status === 403 || status === 404) {
        return handleError(new Error(`You are not a member of '${tenantSlug}'.`));
      }
      if (status < 200 || status >= 300) {
        return handleError(new Error(bodyError(json, `Switch failed (HTTP ${status}).`)));
      }
      const token = fieldString(json, "session_token", "token");
      if (!token) return handleError(new Error("Switch response did not include a session token."));
      const persist = persistClientEnvSessionToken(token);
      resetSelfHostedConfigCache();
      const org = tenantLabel(json) || tenantSlug;
      output(
        { switched: true, tenant: asObject(json)["tenant"] ?? { slug: tenantSlug }, persisted: persist.scope },
        `${chalk.green(`✓ Active org is now ${org}.`)}\n${persistenceNote(persist)}`,
      );
    } catch (error) {
      handleError(error);
    }
  };
}

function handleVerifyEmail(output: OutputFn) {
  return async (token: string | undefined, opts: { resend?: boolean; email?: string }) => {
    try {
      if (opts.resend) {
        const email = await resolveEmail(opts.email);
        const { status, json } = selfHostedApiRequest(
          "POST",
          "/auth/verify-email/resend",
          { email },
          { requireCredential: false },
        );
        if (status < 200 || status >= 300) {
          return handleError(new Error(bodyError(json, `Could not resend verification (HTTP ${status}).`)));
        }
        return output(
          { resent: true, email },
          chalk.green(`✓ Verification email re-sent to ${email} (if that account exists).`),
        );
      }
      const value = (token ?? "").trim() || (await promptText("Verification token: "));
      const { status, json } = selfHostedApiRequest(
        "POST",
        "/auth/verify-email",
        { token: value },
        { requireCredential: false },
      );
      if (status === 400 || status === 404 || status === 410) {
        return handleError(new Error("Invalid or expired verification token. Request a new one with --resend."));
      }
      if (status < 200 || status >= 300) {
        return handleError(new Error(bodyError(json, `Verification failed (HTTP ${status}).`)));
      }
      output(
        { verified: true, user: asObject(json)["user"] ?? null },
        chalk.green("✓ Email verified. You can now run: emails auth login"),
      );
    } catch (error) {
      handleError(error);
    }
  };
}

function handleBootstrap(output: OutputFn) {
  return async (opts: { email?: string; password?: string; name?: string }) => {
    try {
      const email = await resolveEmail(opts.email);
      const password = await resolvePassword(opts.password);
      const body: Record<string, unknown> = { email, password };
      if (opts.name?.trim()) body["name"] = opts.name.trim();
      // API-key auth: uses the operator's existing EMAILS_SELF_HOSTED_API_KEY.
      const { status, json } = selfHostedApiRequest("POST", "/auth/bootstrap-owner", body);
      if (status === 403 && bodyReason(json) === "email_not_allowed") {
        return handleError(new Error("The owner email must be a @hasna.<tld> address."));
      }
      if (status === 401 || status === 403) {
        return handleError(
          new Error("Bootstrap requires the operator API key (EMAILS_SELF_HOSTED_API_KEY)."),
        );
      }
      if (status === 409) {
        return handleError(new Error("This tenant already has an owner; bootstrap can only run once."));
      }
      if (status < 200 || status >= 300) {
        return handleError(new Error(bodyError(json, `Bootstrap failed (HTTP ${status}).`)));
      }
      output(
        { bootstrapped: true, user: asObject(json)["user"] ?? { email }, tenant: asObject(json)["tenant"] ?? null },
        [
          chalk.green(`✓ Owner account created for ${email}.`),
          chalk.dim("If email verification is required, verify first, then run: emails auth login"),
        ].join("\n"),
      );
    } catch (error) {
      handleError(error);
    }
  };
}

// ── tenant-scoped API keys (/v1/keys) ───────────────────────────────────────

function keysAdminError(): Error {
  return new Error("Managing API keys requires an admin or owner session. Run: emails auth login");
}

function handleKeysList(output: OutputFn) {
  return async () => {
    try {
      const { status, json } = selfHostedApiRequest("GET", "/keys");
      if (status === 401 || status === 403) return handleError(keysAdminError());
      if (status < 200 || status >= 300) return handleError(new Error(bodyError(json, `List keys failed (HTTP ${status}).`)));
      const obj = asObject(json);
      const keys = (Array.isArray(obj["keys"]) ? obj["keys"] : Array.isArray(json) ? json : []) as Array<Record<string, unknown>>;
      if (keys.length === 0) return output([], chalk.dim("No API keys for this org."));
      const lines = [chalk.bold("\nAPI keys (tenant-scoped):")];
      for (const k of keys) {
        const kid = fieldString(k, "kid", "id") ?? "?";
        const scopes = Array.isArray(k["scopes"]) ? (k["scopes"] as unknown[]).join(",") : "";
        const state = k["revoked_at"] || k["revokedAt"] ? chalk.red("revoked") : chalk.green("active");
        lines.push(`  ${chalk.cyan(kid)}  ${scopes}  [${state}]`);
      }
      output(keys, lines.join("\n"));
    } catch (error) {
      handleError(error);
    }
  };
}

function handleKeysCreate(output: OutputFn) {
  return async (opts: { scope: string[]; ttlDays: string; expiry: boolean; agent?: string }) => {
    try {
      const body: Record<string, unknown> = { scopes: opts.scope };
      body["ttl_days"] = opts.expiry === false ? null : Number(opts.ttlDays);
      if (opts.agent?.trim()) body["agent"] = opts.agent.trim();
      const { status, json } = selfHostedApiRequest("POST", "/keys", body);
      if (status === 401 || status === 403) return handleError(keysAdminError());
      if (status < 200 || status >= 300) return handleError(new Error(bodyError(json, `Create key failed (HTTP ${status}).`)));
      const token = fieldString(json, "token");
      const kid = fieldString(json, "kid", "id");
      const scopes = Array.isArray(asObject(json)["scopes"]) ? (asObject(json)["scopes"] as unknown[]) : opts.scope;
      const expiresAt = fieldString(json, "expires_at", "expiresAt");
      output(
        { token, kid, scopes, expires_at: expiresAt },
        [
          chalk.green("API key created for this org. Save this token now; it will not be shown again:"),
          chalk.bold(`\n  ${token ?? "(no token returned)"}\n`),
          chalk.dim(`Key id: ${kid ?? "?"}${expiresAt ? `   expires: ${expiresAt}` : ""}`),
        ].join("\n"),
      );
    } catch (error) {
      handleError(error);
    }
  };
}

function handleKeysRevoke(output: OutputFn) {
  return async (kid: string) => {
    try {
      const target = kid.trim();
      const { status, json } = selfHostedApiRequest("DELETE", `/keys/${encodeURIComponent(target)}`);
      if (status === 401 || status === 403) return handleError(keysAdminError());
      if (status === 404) return handleError(new Error(`API key not found in this org: ${target}`));
      if (status < 200 || status >= 300) return handleError(new Error(bodyError(json, `Revoke failed (HTTP ${status}).`)));
      output({ kid: target, revoked: true }, chalk.green(`✓ Revoked API key ${target}.`));
    } catch (error) {
      handleError(error);
    }
  };
}

// ── registration ────────────────────────────────────────────────────────────

export function registerAuthCommands(program: Command, output: OutputFn): void {
  const auth = program.command("auth").description("User accounts, sessions, and tenant sign-in for the self-hosted service");

  auth
    .command("signup")
    .description("Create a new organization and its owner account (email verification required)")
    .option("--email <email>", "Owner email (must be @hasna.<tld>)")
    .option("--password <password>", "Owner password (prompted if omitted)")
    .option("--name <name>", "Owner display name")
    .option("--tenant-name <name>", "Organization display name")
    .option("--tenant-slug <slug>", "Organization slug (lowercase, url-safe)")
    .action(handleSignup(output));

  auth
    .command("login")
    .description("Sign in and persist a session token for subsequent commands")
    .option("--email <email>", "Account email")
    .option("--password <password>", "Account password (prompted if omitted)")
    .option("--tenant <slug>", "Organization to sign into (if you belong to several)")
    .action(handleLogin(output));

  auth
    .command("logout")
    .description("Revoke the current session and clear the stored token")
    .action(handleLogout(output));

  auth
    .command("whoami")
    .description("Show the signed-in user, active org, and role")
    .action(handleWhoami(output));

  auth
    .command("switch-tenant <slug>")
    .description("Switch the active organization (mints a new session for it)")
    .action(handleSwitchTenant(output));

  auth
    .command("verify-email [token]")
    .description("Complete email verification with a token, or resend the email")
    .option("--resend", "Resend the verification email instead of verifying")
    .option("--email <email>", "Email to resend the verification link to")
    .action(handleVerifyEmail(output));

  auth
    .command("bootstrap")
    .description("One-time: use the operator API key to create the first owner user")
    .option("--email <email>", "Owner email (must be @hasna.<tld>)")
    .option("--password <password>", "Owner password (prompted if omitted)")
    .option("--name <name>", "Owner display name")
    .action(handleBootstrap(output));

  // Top-level alias: `emails whoami`.
  program
    .command("whoami")
    .description("Show the signed-in user, active org, and role")
    .action(handleWhoami(output));

  // Tenant-scoped API keys — `emails keys …` (routes to /v1/keys).
  const keys = program.command("keys").description("Tenant-scoped API keys for the active organization (admin/owner)");
  keys
    .command("list")
    .description("List the active org's API keys (no tokens or hashes)")
    .action(handleKeysList(output));
  keys
    .command("create")
    .description("Mint a tenant-scoped API key; the token is shown once")
    .option("--scope <scope...>", "Granted scope(s): emails:read, emails:write, emails:*", ["emails:*"])
    .option("--ttl-days <days>", "Expiry in days", "90")
    .option("--no-expiry", "Create a key without expiry")
    .option("--agent <name>", "Optional key subject")
    .action(handleKeysCreate(output));
  keys
    .command("revoke <kid>")
    .description("Revoke an API key by key id (must belong to the active org)")
    .action(handleKeysRevoke(output));
}
