import type { ExtensionSettings, IndexStateMap } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const SETTINGS_KEY = "extensionSettings";
const INDEX_STATE_KEY = "bookmarkIndexState";

export async function loadSettings(): Promise<ExtensionSettings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] as ExtensionSettings | undefined;
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(s: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function loadIndexState(): Promise<IndexStateMap> {
  const r = await chrome.storage.local.get(INDEX_STATE_KEY);
  return (r[INDEX_STATE_KEY] as IndexStateMap) || {};
}

export async function saveIndexState(map: IndexStateMap): Promise<void> {
  await chrome.storage.local.set({ [INDEX_STATE_KEY]: map });
}

export async function clearIndexState(): Promise<void> {
  await chrome.storage.local.remove(INDEX_STATE_KEY);
}
