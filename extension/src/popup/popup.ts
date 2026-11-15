import { MSG, domainOf, type OkReply, type Settings, type TabState } from "@xcavate/shared/core";
import { loadSettings, saveSettings } from "../lib/settings";
import { renderPopup, type PopupView } from "./render";

/** Popup entry (U-03, U-04). Reads tab state from the service worker; settings from chrome.storage. */

const POLL_MS = 900;
// Policy fetches (up to 8 s) plus the analyze call (25 s client timeout), with room to spare.
const POLL_LIMIT_MS = 45_000;

async function main() {
  const root = document.getElementById("app")!;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  let domain: string | undefined;
  // No URL means Chrome doesn't let us read this tab (chrome://, the Web Store, file://).
  let restricted = !tab?.url;
  try {
    if (tab?.url) {
      const u = new URL(tab.url);
      restricted = u.protocol !== "http:" && u.protocol !== "https:";
      if (!restricted) domain = domainOf(tab.url);
    }
  } catch {
    restricted = true;
  }

  const view: PopupView = { settings: await loadSettings(), domain, tabTitle: tab?.title ?? "", restricted };
  let pollUntil = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (tabId === undefined) return;
    view.state = (await chrome.runtime.sendMessage({ type: MSG.GET_STATE, tabId }).catch(() => undefined)) as TabState | undefined;
    if (view.state?.report?.domain && !view.domain) view.domain = view.state.report.domain;
    if (view.scanning && view.state && view.state.status !== "checking") view.scanning = false;
    draw();
    if (view.state?.status === "checking" && Date.now() < pollUntil) pollTimer = setTimeout(refresh, POLL_MS);
    else view.scanning = false;
  };

  const updateSettings = async (patch: Partial<Settings>) => {
    view.settings = await saveSettings(patch);
    view.settingsSaved = patch.apiBase !== undefined;
    draw();
  };

  const draw = () =>
    renderPopup(root, view, {
      scan: async () => {
        if (tabId === undefined) return;
        view.scanning = true;
        view.scanError = undefined;
        draw();
        const r = (await chrome.runtime.sendMessage({ type: MSG.SCAN_TAB, tabId }).catch(() => undefined)) as OkReply | undefined;
        if (!r?.ok) {
          view.scanning = false;
          view.scanError = r?.error ?? "Couldn't scan this page.";
          draw();
          return;
        }
        pollUntil = Date.now() + POLL_LIMIT_MS;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(refresh, POLL_MS);
      },
      setEnabled: (v) => void updateSettings({ enabled: v }),
      setPaused: (v) => {
        if (!domain) return;
        const set = new Set(view.settings.pausedDomains);
        if (v) set.add(domain);
        else set.delete(domain);
        void updateSettings({ pausedDomains: Array.from(set) });
      },
      saveApiBase: (v) => void updateSettings({ apiBase: v }),
      setAiCheck: (v) => void updateSettings({ aiCheck: v }),
      downloadIcs: (filename, ics) => {
        const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      },
    });

  pollUntil = Date.now() + POLL_LIMIT_MS;
  draw();
  await refresh();
}

void main();
