import { SAMPLE_REPORT_RED, DEFAULT_SETTINGS, type Report } from "@xcavate/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../fixtures/load";
import { Card, describeWatchers } from "../src/content/card";
import { thirdPartyAddresses } from "../src/content/watchers";
import { matchWatcher, matchWatchers } from "../src/lib/watchers";

const findWatchers = (d: Document) => matchWatchers(thirdPartyAddresses(d));
import { renderPopup } from "../src/popup/render";
import { setLiveDocument } from "./helpers";

function docWith(html: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.head.innerHTML = html;
  return d;
}

describe("matchWatcher", () => {
  it("matches the vendor host and its subdomains", () => {
    expect(matchWatcher("https://static.hotjar.com/c/hotjar-1.js")?.vendor).toBe("Hotjar");
    expect(matchWatcher("https://edge.fullstory.com/s/fs.js")?.vendor).toBe("FullStory");
    expect(matchWatcher("https://www.clarity.ms/tag/abc")?.kind).toBe("session_replay");
    expect(matchWatcher("https://connect.facebook.net/en_US/fbevents.js")).toMatchObject({ vendor: "Meta", kind: "ad_pixel" });
  });

  it("never matches lookalikes or other schemes", () => {
    expect(matchWatcher("https://fullstory.com.evil.example/fs.js")).toBeUndefined();
    expect(matchWatcher("https://notfullstory.com/fs.js")).toBeUndefined();
    expect(matchWatcher("https://shop.example/hotjar.com.js")).toBeUndefined();
    expect(matchWatcher("data:text/javascript,hotjar.com")).toBeUndefined();
    expect(matchWatcher("not a url")).toBeUndefined();
  });

  it("path rules: Pinterest's tag, not its image CDN; Meta's /tr pixel, not facebook.com pages", () => {
    expect(matchWatcher("https://s.pinimg.com/ct/core.js")?.vendor).toBe("Pinterest");
    expect(matchWatcher("https://s.pinimg.com/images/logo.png")).toBeUndefined();
    expect(matchWatcher("https://www.facebook.com/tr?id=1&ev=Purchase")?.vendor).toBe("Meta");
    expect(matchWatcher("https://www.facebook.com/shop")).toBeUndefined();
  });
});

describe("findWatchers", () => {
  it("Gadgetly checkout: Hotjar and Meta, recorder first; the consent-parked Clarity tag is not reported", () => {
    setLiveDocument(loadFixture("gadgetly", "checkout"));
    expect(findWatchers(document)).toEqual([
      { kind: "session_replay", vendor: "Hotjar" },
      { kind: "ad_pixel", vendor: "Meta" },
    ]);
  });

  it("FairBox (clean control) reports nothing", () => {
    setLiveDocument(loadFixture("fairbox", "checkout"));
    expect(findWatchers(document)).toEqual([]);
  });

  it("each vendor once; module scripts and frames count, inline scripts don't", () => {
    const d = docWith(
      '<script src="https://snap.licdn.com/li.lms-analytics/insight.min.js"></script>' +
        '<script src="https://px.ads.linkedin.com/collect"></script>' +
        '<script type="module" src="https://analytics.tiktok.com/i18n/pixel/events.js"></script>' +
        '<iframe src="https://bat.bing.com/action/0"></iframe>' +
        "<script>var s='https://static.hotjar.com/c/hotjar.js'</script>",
    );
    expect(findWatchers(d).map((w: { vendor: string }) => w.vendor)).toEqual(["LinkedIn", "TikTok", "Microsoft Ads"]);
  });

  it("reads resource timing too (scripts injected by a loader and already removed)", () => {
    const d = docWith("");
    const getEntriesByType = vi.fn(() => [{ name: "https://rs.fullstory.com/rec/bundle" }]);
    Object.defineProperty(d, "defaultView", { value: { performance: { getEntriesByType } } });
    expect(findWatchers(d)).toEqual([{ kind: "session_replay", vendor: "FullStory" }]);
  });
});

describe("thirdPartyAddresses", () => {
  it("drops the page's own host and query strings", () => {
    // The live jsdom document has a real location; its own host must never be reported.
    const own = window.location.origin;
    document.head.innerHTML = `<script src="${own}/app.js"></script><script src="https://static.hotjar.com/c/hotjar-9.js?sv=6&uid=123"></script>`;
    expect(thirdPartyAddresses(document)).toEqual(["static.hotjar.com/c/hotjar-9.js"]);
    document.head.innerHTML = "";
  });
});

describe("describeWatchers", () => {
  it("groups by kind", () => {
    expect(
      describeWatchers([
        { kind: "session_replay", vendor: "FullStory" },
        { kind: "ad_pixel", vendor: "Meta" },
        { kind: "ad_pixel", vendor: "TikTok" },
      ]),
    ).toBe("FullStory (session recording); Meta, TikTok (ad tracking)");
    expect(describeWatchers([{ kind: "ad_pixel", vendor: "Meta" }])).toBe("Meta (ad tracking)");
  });
});

describe("card and popup", () => {
  beforeEach(() => {
    document.body.innerHTML = "<main id='app'></main>";
  });

  it("card: one 'Watching this checkout' note in the details; the verdict is untouched", () => {
    const card = new Card(document, { shadowMode: "open" });
    card.showReport(SAMPLE_REPORT_RED);
    card.setLocal({ watchers: [{ kind: "session_replay", vendor: "Hotjar" }] });
    const note = card.shadow.querySelector(".note.watch");
    expect(note?.textContent).toBe("Watching this checkout: Hotjar (session recording).");
    expect(note?.closest(".details")).not.toBeNull();
    expect(card.shadow.querySelector(".card")?.getAttribute("data-verdict")).toBe("red");
    card.hide();
  });

  it("popup: lists recorders and pixels, puts the policy's verified sharing sentence beside them", () => {
    const report: Report = {
      ...SAMPLE_REPORT_RED,
      flags: [
        ...SAMPLE_REPORT_RED.flags,
        {
          ...SAMPLE_REPORT_RED.flags[0],
          category: "data_sharing",
          title: "Shares data with partners",
          quote: "We share information about your purchases with our advertising partners.",
          policyUrl: "https://shop.example/privacy",
        },
      ],
    };
    const root = document.getElementById("app")!;
    const noop = () => {};
    renderPopup(
      root,
      {
        settings: DEFAULT_SETTINGS,
        domain: "shop.example",
        state: { status: "ready", report, watchers: [{ kind: "session_replay", vendor: "FullStory" }, { kind: "ad_pixel", vendor: "Meta" }] },
      },
      { scan: noop, setEnabled: noop, setPaused: noop, saveApiBase: noop, downloadIcs: noop },
    );
    const sec = root.querySelector("section.watch")!;
    expect(sec.querySelector("h2")?.textContent).toBe("Watching this checkout");
    expect(sec.textContent).toContain("FullStory records how you use this page");
    expect(sec.textContent).toContain("Meta ad tracking gets activity from this page");
    expect(sec.querySelector("blockquote")?.textContent).toContain("advertising partners");
    expect(sec.querySelector("a")?.getAttribute("href")).toContain("#:~:text=");
    expect(sec.textContent).toContain("nothing was sent");
  });

  it("popup: no section when nothing was found", () => {
    const root = document.getElementById("app")!;
    const noop = () => {};
    renderPopup(root, { settings: DEFAULT_SETTINGS, state: { status: "ready", report: SAMPLE_REPORT_RED, watchers: [] } }, { scan: noop, setEnabled: noop, setPaused: noop, saveApiBase: noop, downloadIcs: noop });
    expect(root.querySelector("section.watch")).toBeNull();
  });
});

describe("watchAddresses", () => {
  it("re-checks a few times as late trackers load, then stops; cancel stops it early", async () => {
    vi.useFakeTimers();
    try {
      const { watchAddresses } = await import("../src/content/watchers");
      document.head.innerHTML = "";
      const onChange = vi.fn();
      const stop = watchAddresses(document, onChange);
      vi.advanceTimersByTime(3000);
      expect(onChange).not.toHaveBeenCalled(); // nothing new yet
      document.head.innerHTML = '<script src="https://www.clarity.ms/tag/late"></script>';
      vi.advanceTimersByTime(4000);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0]).toContain("www.clarity.ms/tag/late");
      stop();
      document.head.innerHTML = '<script src="https://edge.fullstory.com/s/fs.js"></script>';
      vi.advanceTimersByTime(20_000);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      document.head.innerHTML = "";
    }
  });
});
