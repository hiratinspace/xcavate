import { CATEGORY_ORDER, SEVERITY_CAPS, SEVERITY_RANK } from "@xcavate/shared";
import type { AnalyzeRequest, Flag, Severity, Verdict } from "@xcavate/shared";

/** Lower a severity to its category cap (section 6.5). Never raises it. */
export function capSeverity(category: Flag["category"], severity: Severity): Severity {
  const cap = SEVERITY_CAPS[category];
  return SEVERITY_RANK[severity] > SEVERITY_RANK[cap] ? cap : severity;
}

export function applyCaps(flags: Flag[]): Flag[] {
  return flags.map((f) => ({ ...f, severity: capSeverity(f.category, f.severity) }));
}

/** Severity desc, then category order (section 6.1). */
export function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

/**
 * Verdict (section 6.5): red = any high; yellow = any medium or 2+ low;
 * green = at least one policy analysed and none of the above; otherwise unknown
 * (e.g. policy links were found but none could be read).
 */
export function computeVerdict(flags: Flag[], analyzedCount: number): Verdict {
  if (flags.some((f) => f.severity === "high")) return "red";
  if (flags.some((f) => f.severity === "medium")) return "yellow";
  if (flags.filter((f) => f.severity === "low").length >= 2) return "yellow";
  if (analyzedCount > 0) return "green";
  return "unknown";
}

/**
 * missing_policy (section 7.4 step 7): a checkout/sign-up page with no policy links.
 * Not added when a policy was still analysed (e.g. found at a well-known path).
 */
export function needsMissingPolicy(req: Pick<AnalyzeRequest, "pageType" | "linksFound">, analyzedCount: number): boolean {
  return req.pageType !== "none" && req.linksFound === 0 && analyzedCount === 0;
}

export const MISSING_POLICY_FLAG: Flag = {
  id: "missing_policy:e3b0c442",
  category: "missing_policy",
  severity: "medium",
  title: "No terms or refund policy found",
  summary: "This page links to no terms or refund policy, so you cannot check the rules before you pay.",
  quote: "",
  policyUrl: "",
  paragraphIndex: -1,
  source: "rules",
};
