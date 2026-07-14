import { ansi } from "./ansi.js";

export interface AnalyticsData {
  dailyVolume: { date: string; count: number }[];
  topRecipients: { email: string; count: number }[];
  busiestHours: { hour: number; count: number }[];
  deliveryTrend: { date: string; sent: number; delivered: number; bounced: number }[];
}

// Analytics joins the local `emails` and `events` tables (send volume + delivery
// trend). The delivery `events` table has NO `/v1` representation in the
// self-hosted client — analytics are computed on the operator's server — so this
// stub fails loud instead of returning a partial (misleading) dashboard.
export function getAnalytics(_providerId?: string, _period = "30d"): AnalyticsData {
  throw new Error(
    "getAnalytics is not available in the self-hosted client; it aggregates the delivery events table, which runs on the self-hosted server.",
  );
}

export function formatAnalytics(data: AnalyticsData): string {
  let output = "";

  // Daily volume - ASCII bar chart
  output += ansi.bold("\n  Daily Send Volume\n");
  if (data.dailyVolume.length === 0) {
    output += "  No data\n";
  } else {
    const maxCount = Math.max(...data.dailyVolume.map((d) => d.count), 1);
    for (const day of data.dailyVolume.slice(-14)) {
      const barLen = Math.round((day.count / maxCount) * 40);
      const bar = ansi.blue("\u2588".repeat(barLen));
      output += `  ${day.date}  ${bar} ${day.count}\n`;
    }
  }

  // Top recipients
  output += ansi.bold("\n  Top Recipients\n");
  if (data.topRecipients.length === 0) {
    output += "  No data\n";
  } else {
    for (const r of data.topRecipients.slice(0, 10)) {
      output += `  ${r.email}  ${ansi.gray(`(${r.count} emails)`)}\n`;
    }
  }

  // Busiest hours
  output += ansi.bold("\n  Busiest Hours\n");
  if (data.busiestHours.length === 0) {
    output += "  No data\n";
  } else {
    const maxHour = Math.max(...data.busiestHours.map((h) => h.count), 1);
    for (const h of data.busiestHours) {
      const barLen = Math.round((h.count / maxHour) * 30);
      const bar = ansi.cyan("\u2588".repeat(barLen));
      output += `  ${String(h.hour).padStart(2, "0")}:00  ${bar} ${h.count}\n`;
    }
  }

  // Delivery trend
  output += ansi.bold("\n  Delivery Trend (last 7 days)\n");
  if (data.deliveryTrend.length === 0) {
    output += "  No data\n";
  } else {
    for (const d of data.deliveryTrend.slice(-7)) {
      const total = d.sent || 1;
      const rate = ((d.delivered / total) * 100).toFixed(1);
      const rateColor = parseFloat(rate) > 95 ? ansi.green : parseFloat(rate) > 80 ? ansi.yellow : ansi.red;
      output += `  ${d.date}  sent:${d.sent} delivered:${d.delivered} bounced:${d.bounced}  ${rateColor(rate + "%")}\n`;
    }
  }

  return output;
}
