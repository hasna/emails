/**
 * Email open/click tracking utilities.
 * Injects tracking pixels and rewrites links to go through the local tracking server.
 */

const TRACKING_BASE_URL_KEY = "tracking-base-url";

/**
 * Inject a 1x1 tracking pixel into HTML email body.
 * Adds <img src="{baseUrl}/track/open/{emailId}" ...> before </body> or at end.
 */
export function injectOpenPixel(html: string, emailId: string, baseUrl: string): string {
  const pixel = `<img src="${baseUrl}/track/open/${emailId}" width="1" height="1" style="display:none;border:0;" alt="" />`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${pixel}</body>`);
  }
  return html + pixel;
}

/**
 * Rewrite all href links in HTML to go through click tracking redirect.
 * Uses URL-safe base64 encoding of the original URL — no DB lookup needed.
 * Only rewrites http/https links; mailto: and other schemes are left alone.
 */
export function injectClickTracking(html: string, emailId: string, baseUrl: string): string {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (_, url: string) => {
    const encoded = Buffer.from(url).toString("base64url");
    return `href="${baseUrl}/track/click/${emailId}/${encoded}"`;
  });
}

/**
 * Get the tracking base URL from config, defaulting to http://localhost:3900.
 */
export async function getTrackingBaseUrl(): Promise<string> {
  try {
    const { getConfigValue } = await import("./config.js");
    return (getConfigValue(TRACKING_BASE_URL_KEY) as string) || "http://localhost:3900";
  } catch {
    return "http://localhost:3900";
  }
}

/**
 * Prepare HTML for sending with tracking injected.
 */
export async function prepareTrackedHtml(
  html: string,
  emailId: string,
  trackOpens: boolean,
  trackClicks: boolean,
): Promise<string> {
  const baseUrl = await getTrackingBaseUrl();
  let result = html;
  if (trackOpens) result = injectOpenPixel(result, emailId, baseUrl);
  if (trackClicks) result = injectClickTracking(result, emailId, baseUrl);
  return result;
}
