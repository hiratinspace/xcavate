import { vi } from "vitest";

/** Minimal in-memory chrome.* mock for service-worker and messaging tests. */

function area() {
  let data: Record<string, unknown> = {};
  return {
    data: () => data,
    reset: () => {
      data = {};
    },
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data[k] = JSON.parse(JSON.stringify(v));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }),
  };
}

export function installChromeMock() {
  const local = area();
  const session = area();
  const badges = new Map<number, { text?: string; color?: string; title?: string }>();
  const listeners: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown)[] = [];
  const chromeMock = {
    runtime: {
      id: "xcavate-test",
      sendMessage: vi.fn(async (_msg: unknown) => undefined as unknown),
      onMessage: { addListener: vi.fn((fn: (typeof listeners)[number]) => listeners.push(fn)) },
    },
    storage: { local, session },
    tabs: {
      sendMessage: vi.fn(async (_tabId: number, _msg: unknown) => undefined as unknown),
      query: vi.fn(async () => []),
      onRemoved: { addListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn(async () => []) },
    action: {
      setBadgeText: vi.fn(async ({ tabId, text }: { tabId: number; text: string }) => {
        badges.set(tabId, { ...badges.get(tabId), text });
      }),
      setBadgeBackgroundColor: vi.fn(async ({ tabId, color }: { tabId: number; color: string }) => {
        badges.set(tabId, { ...badges.get(tabId), color });
      }),
      setBadgeTextColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async ({ tabId, title }: { tabId: number; title: string }) => {
        badges.set(tabId, { ...badges.get(tabId), title });
      }),
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  return { chrome: chromeMock, local, session, badges, listeners };
}
