import type { Message } from "@xcavate/shared";
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
