import type { Message, Settings } from "@xcavate/shared";
import { SETTINGS_KEY } from "../lib/settings";
import { createHandlers } from "./handlers";
import { clearTab } from "./state";

/** Service worker entry: wires chrome listeners to the handlers. */

const handlers = createHandlers();

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content scripts.
  if (sender.id !== chrome.runtime.id) return false;
  handlers
    .handle(msg, sender)
    .then((reply) => sendResponse(reply))
    .catch((e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }));
  return true; // async reply
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId);
});

// A full navigation (or an SPA route change) to another page ends the old page's state and badge.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  void handlers.tabUpdated(tabId, info, tab?.url).catch(() => undefined);
});

// Turning the AI check off cancels backend calls already in flight.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  const { newValue, oldValue } = changes[SETTINGS_KEY] as { newValue?: Partial<Settings>; oldValue?: Partial<Settings> };
  handlers.settingsChanged(newValue, oldValue);
});
