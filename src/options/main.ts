import { testQaSettings, testRagSettings } from "../lib/api";
import { loadSettings, saveSettings } from "../lib/storage";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../lib/types";

const ragBaseUrl = document.getElementById("ragBaseUrl") as HTMLInputElement;
const ragApiKey = document.getElementById("ragApiKey") as HTMLInputElement;
const ragModel = document.getElementById("ragModel") as HTMLInputElement;
const ragEmbedPath = document.getElementById("ragEmbedPath") as HTMLInputElement;
const ragChunkSize = document.getElementById("ragChunkSize") as HTMLInputElement;
const ragChunkOverlap = document.getElementById("ragChunkOverlap") as HTMLInputElement;
const ragTextMaxChars = document.getElementById("ragTextMaxChars") as HTMLInputElement;
const ragEmbeddingsTimeoutSec = document.getElementById("ragEmbeddingsTimeoutSec") as HTMLInputElement;
const qaBaseUrl = document.getElementById("qaBaseUrl") as HTMLInputElement;
const qaApiKey = document.getElementById("qaApiKey") as HTMLInputElement;
const qaModel = document.getElementById("qaModel") as HTMLInputElement;
const qaMode = document.getElementById("qaMode") as HTMLSelectElement;
const qaReasoningEffort = document.getElementById("qaReasoningEffort") as HTMLSelectElement;
const qaResponsesPath = document.getElementById("qaResponsesPath") as HTMLInputElement;
const qaChatPath = document.getElementById("qaChatPath") as HTMLInputElement;
const qaCompletionsPath = document.getElementById("qaCompletionsPath") as HTMLInputElement;
const qaPromptTemplate = document.getElementById("qaPromptTemplate") as HTMLTextAreaElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const exportBtn = document.getElementById("export-settings") as HTMLButtonElement;
const importBtn = document.getElementById("import-settings") as HTMLButtonElement;
const downloadBtn = document.getElementById("download-settings") as HTMLButtonElement;
const uploadBtn = document.getElementById("upload-settings") as HTMLButtonElement;
const importFile = document.getElementById("import-file") as HTMLInputElement;
const statusEl = document.getElementById("status")!;
const shortcutList = document.getElementById("shortcut-list")!;
const testRagBtn = document.getElementById("test-rag") as HTMLButtonElement;
const testQaBtn = document.getElementById("test-qa") as HTMLButtonElement;
const ragTestStatus = document.getElementById("rag-test-status")!;
const qaTestStatus = document.getElementById("qa-test-status")!;

document.getElementById("shortcuts-link")!.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

async function fill() {
  const s = await loadSettings();
  ragBaseUrl.value = s.ragBaseUrl;
  ragApiKey.value = s.ragApiKey;
  ragModel.value = s.ragModel || DEFAULT_SETTINGS.ragModel;
  ragEmbedPath.value = s.ragEmbedPath || DEFAULT_SETTINGS.ragEmbedPath;
  ragChunkSize.value = String(s.ragChunkSize ?? DEFAULT_SETTINGS.ragChunkSize);
  ragChunkOverlap.value = String(s.ragChunkOverlap ?? DEFAULT_SETTINGS.ragChunkOverlap);
  ragTextMaxChars.value = String(s.ragTextMaxChars ?? DEFAULT_SETTINGS.ragTextMaxChars);
  ragEmbeddingsTimeoutSec.value = String(
    Math.round((s.ragEmbeddingsTimeoutMs ?? DEFAULT_SETTINGS.ragEmbeddingsTimeoutMs) / 1000)
  );
  qaBaseUrl.value = s.qaBaseUrl;
  qaApiKey.value = s.qaApiKey;
  qaModel.value = s.qaModel || DEFAULT_SETTINGS.qaModel;
  qaMode.value =
    s.qaMode === "chat" ? "chat" : s.qaMode === "completions" ? "completions" : "responses";
  qaReasoningEffort.value = s.qaReasoningEffort || DEFAULT_SETTINGS.qaReasoningEffort;
  qaResponsesPath.value = s.qaResponsesPath || DEFAULT_SETTINGS.qaResponsesPath;
  qaChatPath.value = s.qaChatPath || DEFAULT_SETTINGS.qaChatPath;
  qaCompletionsPath.value = s.qaCompletionsPath || DEFAULT_SETTINGS.qaCompletionsPath;
  qaPromptTemplate.value = s.qaPromptTemplate || DEFAULT_SETTINGS.qaPromptTemplate;

  chrome.commands.getAll((cmds) => {
    shortcutList.innerHTML = "";
    cmds.forEach((c) => {
      const li = document.createElement("li");
      li.textContent = `${c.description || c.name}: ${c.shortcut || "(not set)"}`;
      shortcutList.appendChild(li);
    });
  });
}

function parsePositiveInt(input: string, fallback: number, min = 0): number {
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function readFormSettings(): ExtensionSettings {
  const chunkSize = parsePositiveInt(
    ragChunkSize.value,
    DEFAULT_SETTINGS.ragChunkSize,
    200
  );
  const chunkOverlap = parsePositiveInt(
    ragChunkOverlap.value,
    DEFAULT_SETTINGS.ragChunkOverlap,
    0
  );
  const maxChars = parsePositiveInt(
    ragTextMaxChars.value,
    DEFAULT_SETTINGS.ragTextMaxChars,
    200
  );
  const timeoutSec = parsePositiveInt(
    ragEmbeddingsTimeoutSec.value,
    Math.round(DEFAULT_SETTINGS.ragEmbeddingsTimeoutMs / 1000),
    5
  );
  const clampedTimeoutSec = Math.min(300, Math.max(5, timeoutSec));
  return {
    ragBaseUrl: ragBaseUrl.value.trim(),
    ragApiKey: ragApiKey.value,
    ragModel: ragModel.value.trim() || DEFAULT_SETTINGS.ragModel,
    ragEmbedPath: ragEmbedPath.value.trim() || DEFAULT_SETTINGS.ragEmbedPath,
    ragChunkSize: chunkSize,
    ragChunkOverlap: Math.min(chunkOverlap, Math.max(0, chunkSize - 1)),
    ragTextMaxChars: maxChars,
    ragEmbeddingsTimeoutMs: clampedTimeoutSec * 1000,
    qaBaseUrl: qaBaseUrl.value.trim(),
    qaApiKey: qaApiKey.value,
    qaModel: qaModel.value.trim() || DEFAULT_SETTINGS.qaModel,
    qaMode:
      qaMode.value === "chat"
        ? "chat"
        : qaMode.value === "completions"
          ? "completions"
          : "responses",
    qaReasoningEffort: (qaReasoningEffort.value || DEFAULT_SETTINGS.qaReasoningEffort) as ExtensionSettings["qaReasoningEffort"],
    qaResponsesPath: qaResponsesPath.value.trim() || DEFAULT_SETTINGS.qaResponsesPath,
    qaChatPath: qaChatPath.value.trim() || DEFAULT_SETTINGS.qaChatPath,
    qaCompletionsPath: qaCompletionsPath.value.trim() || DEFAULT_SETTINGS.qaCompletionsPath,
    qaPromptTemplate: qaPromptTemplate.value.trim() || DEFAULT_SETTINGS.qaPromptTemplate,
  };
}

saveBtn.addEventListener("click", async () => {
  await saveSettings(readFormSettings());
  statusEl.textContent = "Saved.";
  statusEl.className = "status ok";
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "status";
  }, 2500);
});

exportBtn.addEventListener("click", async () => {
  const settings = readFormSettings();
  const payload = JSON.stringify(settings, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    statusEl.textContent = "Exported settings copied to clipboard.";
    statusEl.className = "status ok";
  } catch {
    statusEl.textContent = "Copy failed. Check permissions in this tab.";
    statusEl.className = "status err";
  }
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "status";
  }, 3000);
});

async function applyImportedSettings(raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    statusEl.textContent = "Invalid JSON. Paste the exported settings JSON.";
    statusEl.className = "status err";
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    statusEl.textContent = "Invalid settings object.";
    statusEl.className = "status err";
    return;
  }
  const merged = { ...DEFAULT_SETTINGS, ...(parsed as Partial<ExtensionSettings>) };
  await saveSettings(merged as ExtensionSettings);
  await fill();
  statusEl.textContent = "Imported settings saved.";
  statusEl.className = "status ok";
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "status";
  }, 3000);
}

importBtn.addEventListener("click", async () => {
  const raw = window.prompt("Paste exported settings JSON");
  if (!raw) return;
  await applyImportedSettings(raw);
});

downloadBtn.addEventListener("click", () => {
  const settings = readFormSettings();
  const payload = JSON.stringify(settings, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "bookmark-rag-settings.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

uploadBtn.addEventListener("click", () => {
  importFile.value = "";
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    await applyImportedSettings(text);
  } catch {
    statusEl.textContent = "Failed to read settings file.";
    statusEl.className = "status err";
  }
});

testRagBtn.addEventListener("click", async () => {
  ragTestStatus.textContent = "Testing…";
  ragTestStatus.className = "test-status";
  testRagBtn.disabled = true;
  try {
    const r = await testRagSettings(readFormSettings());
    ragTestStatus.textContent = r.detail;
    ragTestStatus.className = r.ok ? "test-status ok" : "test-status err";
  } finally {
    testRagBtn.disabled = false;
  }
});

testQaBtn.addEventListener("click", async () => {
  qaTestStatus.textContent = "Testing…";
  qaTestStatus.className = "test-status";
  testQaBtn.disabled = true;
  try {
    const r = await testQaSettings(readFormSettings());
    qaTestStatus.textContent = r.detail;
    qaTestStatus.className = r.ok ? "test-status ok" : "test-status err";
  } finally {
    testQaBtn.disabled = false;
  }
});

fill();
