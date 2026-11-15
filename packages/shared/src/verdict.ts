import type { Report, Verdict } from "./types.js";

export const VERDICT_ICON: Record<Verdict, string> = { red: "!", yellow: "~", green: "✓", unknown: "?" };
export const VERDICT_WORD: Record<Verdict, string> = {
  red: "Read first",
  yellow: "Worth a look",
  green: "Looks fair",
  unknown: "Couldn't read",
};

/** Card headline per verdict (section 7.10). */
export function verdictHeadline(report: Pick<Report, "verdict" | "flags">): string {
  switch (report.verdict) {
    case "red": {
      const n = Math.min(report.flags.length, 3);
      return n === 1 ? "1 thing to read before you pay" : n + " things to read before you pay";
    }
    case "yellow":
      return "Worth a quick look";
    case "green":
      return "No money traps found in the terms";
    case "unknown":
      return "Couldn't read this site's terms. Open them and press Scan this page.";
  }
}

export const DISCLAIMER = "Automated summary, not legal advice.";
