import { SAMPLE_REPORT_RED } from "@xcavate/shared";
import { describe, expect, it } from "vitest";
import { buildCancellationMailto, buildTrialReminder, contactHref, storeName, trialPolicyUrl } from "../src/lib/actions";

const TODAY = new Date(2026, 10, 14); // 14 Nov 2026, local time

describe("storeName", () => {
  it("takes the casing from the tab title when it matches the domain", () => {
    expect(storeName("streamnest.localhost:4000", "Start your free trial | StreamNest")).toBe("StreamNest");
    expect(storeName("www.shop.example.com", "")).toBe("Example");
    expect(storeName("fairbox.localhost:4000")).toBe("Fairbox");
  });
});

describe("F-03 trial reminder", () => {
  const r = buildTrialReminder(SAMPLE_REPORT_RED.trial, "StreamNest", trialPolicyUrl(SAMPLE_REPORT_RED), TODAY)!;

  it("dates the all-day event today + lengthDays − 2", () => {
    expect(r.date.getFullYear()).toBe(2026);
    expect(r.date.getMonth()).toBe(10);
    expect(r.date.getDate()).toBe(19);
    expect(r.calendarUrl).toContain("dates=20261119/20261120");
    expect(r.calendarUrl.startsWith("https://calendar.google.com/calendar/render?action=TEMPLATE&text=")).toBe(true);
  });

  it("uses the agreed title without an em dash, and details carry price and policy link", () => {
    expect(r.title).toBe("StreamNest trial ends in 2 days: cancel or keep?");
    expect(r.title).not.toContain("—");
    expect(r.details).toContain("$14.99 per month");
    expect(r.details).toContain("http://streamnest.localhost:4000/subscription");
    expect(decodeURIComponent(r.calendarUrl)).toContain("$14.99");
  });

  it("produces a valid-looking .ics", () => {
    expect(r.ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(r.ics).toContain("DTSTART;VALUE=DATE:20261119");
    expect(r.ics).toContain("DTEND;VALUE=DATE:20261120");
    expect(r.ics).toContain("SUMMARY:StreamNest trial ends in 2 days: cancel or keep?");
    for (const line of r.ics.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
  });

  it("is absent without a trial length", () => {
    expect(buildTrialReminder(undefined, "X", "", TODAY)).toBeUndefined();
    expect(buildTrialReminder({ priceAfter: "$5" }, "X", "", TODAY)).toBeUndefined();
  });
});

describe("F-04 cancellation helper", () => {
  it("drafts a mailto with subject and body, pre-filling a policy email", () => {
    const m = buildCancellationMailto("StreamNest", { method: "email", steps: [], contact: "Email cancel@streamnest.example" });
    expect(m.startsWith("mailto:cancel@streamnest.example?subject=Cancellation%20request&body=")).toBe(true);
    expect(decodeURIComponent(m)).toContain("Please cancel my StreamNest subscription");
  });
  it("leaves the address empty for phone-only", () => {
    expect(buildCancellationMailto("StreamNest", SAMPLE_REPORT_RED.cancellation).startsWith("mailto:?subject=")).toBe(true);
  });
  it("links contacts", () => {
    expect(contactHref("1-800-555-0199")).toBe("tel:18005550199");
    expect(contactHref("help@x.example")).toBe("mailto:help@x.example");
    expect(contactHref("https://x.example/cancel")).toBe("https://x.example/cancel");
    expect(contactHref("our office")).toBeUndefined();
  });
});
