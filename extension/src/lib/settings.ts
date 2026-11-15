import { DEFAULT_SETTINGS, type Settings } from "@xcavate/shared/core";

/** Settings live in chrome.storage.local under "settings" (BUILD_PLAN 6.4). Used by the service worker and popup. */

export const SETTINGS_KEY = "settings";

export function normalizeApiBase(s: string): string {
  const t = s.trim().replace(/\/+$/, "");
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_SETTINGS.apiBase;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return DEFAULT_SETTINGS.apiBase;
  }
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const s = (got?.[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    enabled: s.enabled ?? DEFAULT_SETTINGS.enabled,
    apiBase: s.apiBase ? normalizeApiBase(s.apiBase) : DEFAULT_SETTINGS.apiBase,
    pausedDomains: Array.isArray(s.pausedDomains) ? s.pausedDomains.filter((d) => typeof d === "string") : [],
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next: Settings = {
    enabled: patch.enabled ?? cur.enabled,
    apiBase: patch.apiBase !== undefined ? normalizeApiBase(patch.apiBase) : cur.apiBase,
    pausedDomains: patch.pausedDomains ?? cur.pausedDomains,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function isActiveFor(settings: Settings, domain: string): boolean {
  return settings.enabled && !settings.pausedDomains.includes(domain);
}
