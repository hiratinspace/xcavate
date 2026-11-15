import type { Report, TabStatus } from "@xcavate/shared";
import { VERDICT_COLOR } from "../content/tokens";

/** U-02 toolbar badge: red "!" + count, yellow count, green "✓", grey "◐" when partly read, grey "?". */

export interface BadgeSpec {
  text: string;
  color: string;
  title: string;
}

export function badgeFor(report: Report | undefined, status: TabStatus): BadgeSpec {
  if (status === "checking" && !report) return { text: "…", color: VERDICT_COLOR.unknown, title: "Xcavate: checking the fine print" };
  if (!report || status === "idle" || status === "error") return { text: "", color: VERDICT_COLOR.unknown, title: "Xcavate" };
  const n = report.flags.length;
  switch (report.verdict) {
    case "red":
      return { text: "!" + n, color: VERDICT_COLOR.red, title: `Xcavate: read first (${n} flags)` };
    case "yellow":
      return { text: String(n || ""), color: VERDICT_COLOR.yellow, title: `Xcavate: worth a look (${n} flags)` };
    case "green":
      return { text: "✓", color: VERDICT_COLOR.green, title: "Xcavate: no money traps found" };
    case "partial":
      // Never green: we only read part of the terms.
      return { text: "◐", color: VERDICT_COLOR.unknown, title: "Xcavate: partly read, no money traps in what we could read" };
    default:
      return { text: "?", color: VERDICT_COLOR.unknown, title: "Xcavate: couldn't read the terms" };
  }
}

export async function setBadge(tabId: number | undefined, report: Report | undefined, status: TabStatus): Promise<void> {
  if (tabId === undefined || tabId < 0) return;
  const b = badgeFor(report, status);
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text });
    if (b.text) await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color });
    await chrome.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" });
    await chrome.action.setTitle({ tabId, title: b.title });
  } catch {
    /* tab closed meanwhile */
  }
}
