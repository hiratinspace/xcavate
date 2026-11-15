import type { Message } from "@xcavate/shared/core";

/** Send a runtime message; resolves undefined instead of throwing (e.g. extension reloaded). */
export async function send<T>(msg: Message): Promise<T | undefined> {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return undefined;
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch {
    return undefined;
  }
}
