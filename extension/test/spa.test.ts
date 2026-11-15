import { afterEach, describe, expect, it, vi } from "vitest";
import { watchNavigation } from "../src/content/spa";

describe("watchNavigation (D-02)", () => {
  afterEach(() => {
    vi.useRealTimers();
    history.replaceState({}, "", "/");
  });

  it("fires after a pushState + DOM swap, debounced, at most once per gap", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<div id='app'><p>product</p></div>";
    const onChange = vi.fn();
    const stop = watchNavigation(window, onChange, { debounceMs: 800, minGapMs: 3000 });

    await vi.advanceTimersByTimeAsync(3100); // past the initial gap
    history.pushState({}, "", "/checkout");
    document.getElementById("app")!.innerHTML = "<form><input autocomplete='cc-number'></form>";
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).not.toHaveBeenCalled(); // still debouncing
    await vi.advanceTimersByTimeAsync(800);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A DOM-only change right away waits for the 3 s gap.
    document.body.appendChild(document.createElement("form"));
    await vi.advanceTimersByTimeAsync(900);
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2200);
    expect(onChange).toHaveBeenCalledTimes(2);

    // A real navigation (popstate) skips the throttle and runs after a short render delay.
    history.pushState({}, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.advanceTimersByTimeAsync(350);
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does no work when URL and form count are unchanged", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<div id='clock'>1</div>";
    const onChange = vi.fn();
    const stop = watchNavigation(window, onChange, { debounceMs: 800, minGapMs: 0 });
    for (let i = 0; i < 10; i++) {
      document.getElementById("clock")!.textContent = String(i);
      document.body.appendChild(document.createElement("span"));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(onChange).not.toHaveBeenCalled();
    stop();
  });
});
