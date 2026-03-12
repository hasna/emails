import { createServer } from "node:http";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/",
].join(" ");

const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}`;

export interface GmailOAuthTokens {
  refresh_token: string;
  access_token: string;
  expiry: string;
}

function buildAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: GMAIL_SCOPES,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<GmailOAuthTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    let msg = `Token exchange failed: ${response.status}`;
    try {
      const err = JSON.parse(body) as { error_description?: string; error?: string };
      msg = `Token exchange failed: ${err.error_description ?? err.error ?? response.statusText}`;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!data.refresh_token) {
    throw new Error(
      "No refresh_token returned. Make sure you use access_type=offline and prompt=consent.",
    );
  }

  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry,
  };
}

/**
 * Run the full Gmail OAuth2 flow:
 *  1. Print auth URL for the user to open in a browser
 *  2. Start a local HTTP server on port 9876 to catch the callback
 *  3. Exchange the auth code for tokens
 *  4. Return the tokens
 */
export async function startGmailOAuthFlow(
  clientId: string,
  clientSecret: string,
): Promise<GmailOAuthTokens> {
  const authUrl = buildAuthUrl(clientId);

  console.log("\nOpen the following URL in your browser to authorize Gmail access:\n");
  console.log(`  ${authUrl}\n`);

  // Try to open the browser automatically
  try {
    const { execSync } = await import("node:child_process");
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${authUrl}"`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`xdg-open "${authUrl}"`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" "${authUrl}"`, { stdio: "ignore" });
    }
  } catch {
    // Browser open failed — user will need to copy-paste manually
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);

      if (url.pathname !== "/" && url.pathname !== "/callback") return;

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      const sendHtml = (body: string) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0"><div style="text-align:center">${body}</div></body></html>`,
        );
      };

      if (error) {
        sendHtml(`<h1 style="color:#dc3545">Auth Failed</h1><p>${error}</p><p>You can close this window.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        try {
          const tokens = await exchangeCode(code, clientId, clientSecret);
          sendHtml(`<h1 style="color:#28a745">Auth Successful!</h1><p>You can close this window and return to the terminal.</p>`);
          server.close();
          resolve(tokens);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendHtml(`<h1 style="color:#dc3545">Auth Failed</h1><p>${msg}</p><p>You can close this window.</p>`);
          server.close();
          reject(err);
        }
      }
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log(`Waiting for OAuth callback on http://127.0.0.1:${REDIRECT_PORT} ...`);
    });

    // 5-minute timeout
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

/**
 * Refresh a Gmail access token using a stored refresh token.
 */
export async function refreshGmailAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expiry: string }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const data = await response.json() as { error_description?: string; error?: string };
    throw new Error(`Token refresh failed: ${data.error_description ?? data.error ?? response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();
  return { access_token: data.access_token, expiry };
}
