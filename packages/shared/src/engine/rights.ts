import type { Flag, Report } from "../core.js";
import { isPhoneOrMailOnly } from "./rules.js";

/**
 * V-08: short, neutral "your rights" notes for clear cases only. Information, never advice,
 * and always fixed template text (no model wording).
 *
 * Source checked 2026-11-14: Cal. Bus. & Prof. Code §17602(d)(1) (current text) requires a
 * business that lets a consumer accept an automatic renewal or continuous service offer online
 * to let the consumer terminate it exclusively online, at will. §17602(j): the AB 2863
 * amendments (Stats. 2024, ch. 515) apply to contracts entered into, amended or extended on or
 * after July 1, 2025. The online-cancel rule itself predates AB 2863, so the note says AB 2863
 * "updated" the rules rather than "created" them.
 */

export const CA_ONLINE_CANCEL_NOTE =
  "If you live in California: state law (Cal. Bus. & Prof. Code §17602(d)(1)) says that if you can sign up for an " +
  "auto-renewing subscription online, you must also be able to cancel it online. AB 2863 updated these rules for " +
  "contracts made on or after July 1, 2025. This is general information, not legal advice.";

export interface RightsNote {
  /** The flag the note belongs to. */
  flagId: string;
  text: string;
}

const SUBSCRIPTION = new Set(["auto_renewal", "trial_converts"]);

function isOnlinePage(pageUrl: string): boolean {
  return /^https?:\/\//i.test(pageUrl);
}

/** A cancellation_friction flag that says phone or mail is the only way to cancel. */
function phoneOrMailOnly(flag: Flag, report: Pick<Report, "cancellation">): boolean {
  if (flag.category !== "cancellation_friction") return false;
  if (isPhoneOrMailOnly(flag.quote)) return true;
  const m = report.cancellation?.method;
  return (m === "phone" || m === "mail") && (!report.cancellation?.quote || isPhoneOrMailOnly(report.cancellation.quote));
}

/**
 * Notes for a report seen on `pageUrl` (the page the shopper is signing up on).
 * Current rule: an auto-renewing subscription (an auto_renewal or trial_converts flag, or a
 * trial) whose cancellation is phone/mail-only, met on a web page, gets the California
 * online-cancellation note on its cancellation_friction flag.
 */
export function rightsNotes(report: Pick<Report, "flags" | "trial" | "cancellation">, pageUrl: string): RightsNote[] {
  if (!isOnlinePage(pageUrl)) return [];
  const subscription = Boolean(report.trial) || report.flags.some((f) => SUBSCRIPTION.has(f.category));
  if (!subscription) return [];
  const target = report.flags.find((f) => phoneOrMailOnly(f, report));
  return target ? [{ flagId: target.id, text: CA_ONLINE_CANCEL_NOTE }] : [];
}

/** Attach notes to their flags as `rightsNote`. */
export function withRightsNotes(flags: Flag[], notes: RightsNote[]): Flag[] {
  if (notes.length === 0) return flags;
  return flags.map((f) => {
    const n = notes.find((x) => x.flagId === f.id);
    return n ? { ...f, rightsNote: n.text } : f;
  });
}
