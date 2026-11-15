/**
 * D-02 single-page-app navigation. Content scripts live in an isolated world, so patching
 * history.pushState here would not see the page's own calls. Instead we listen to the
 * Navigation API (when present), popstate, and a debounced MutationObserver that compares
 * a cheap signature (URL without hash + form count) and does nothing when it is unchanged.
 */

export interface WatchOptions {
  debounceMs?: number;
  minGapMs?: number;
  navDelayMs?: number;
}

/** `urlChanged` is false when only the number of forms changed on the same address. */
export function watchNavigation(win: Window, onChange: (urlChanged: boolean) => void, opts: WatchOptions = {}): () => void {
  const debounceMs = opts.debounceMs ?? 800;
  const minGapMs = opts.minGapMs ?? 3000;
  const navDelayMs = opts.navDelayMs ?? 300;
  const doc = win.document;
  const signature = () => win.location.href.split("#")[0] + "|" + doc.forms.length;

  let last = signature();
  let lastRun = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = (force = false) => {
    timer = undefined;
    const wait = lastRun + minGapMs - Date.now();
    if (!force && wait > 0) {
      timer = setTimeout(check, wait);
      return;
    }
    const s = signature();
    if (s === last) return;
    const urlChanged = s.split("|")[0] !== last.split("|")[0];
    last = s;
    lastRun = Date.now();
    onChange(urlChanged);
  };
  // Trailing timer that is not pushed back by later mutations, so a page that mutates
  // constantly (a ticking clock) still gets checked, at most once per minGapMs.
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(check, debounceMs);
  };
  // An actual navigation (URL change) skips the mutation throttle: short wait for the view to render.
  const onNavigate = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => check(true), navDelayMs);
  };

  const nav = (win as unknown as { navigation?: EventTarget }).navigation;
  // history.pushState fires "currententrychange" on the Navigation API (Chrome 102+), which the
  // isolated world can observe even though it cannot see the page's pushState call itself.
  nav?.addEventListener?.("currententrychange", onNavigate);
  nav?.addEventListener?.("navigatesuccess", onNavigate);
  win.addEventListener("popstate", onNavigate);
  const mo = new MutationObserver(schedule);
  mo.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });

  return () => {
    if (timer) clearTimeout(timer);
    nav?.removeEventListener?.("currententrychange", onNavigate);
    nav?.removeEventListener?.("navigatesuccess", onNavigate);
    win.removeEventListener("popstate", onNavigate);
    mo.disconnect();
  };
}
