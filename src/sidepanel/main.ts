import type { BgResponse } from "../lib/types";

const indexLog = document.getElementById("index-log")!;
const btnFull = document.getElementById("btn-full") as HTMLButtonElement;
const btnIncr = document.getElementById("btn-incr") as HTMLButtonElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnAsk = document.getElementById("btn-ask") as HTMLButtonElement;
const queryEl = document.getElementById("query") as HTMLTextAreaElement;
const answerEl = document.getElementById("answer")!;
const citationsEl = document.getElementById("citations")!;

document.getElementById("open-options")!.addEventListener("click", (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

function logLine(s: string) {
  const t = new Date().toISOString().slice(11, 19);
  indexLog.textContent += `[${t}] ${s}\n`;
  indexLog.scrollTop = indexLog.scrollHeight;
}

function setIndexing(busy: boolean) {
  btnFull.disabled = busy;
  btnIncr.disabled = busy;
  btnTest.disabled = busy;
}

chrome.runtime.onMessage.addListener((msg: BgResponse) => {
  if (msg.type === "INDEX_PROGRESS") {
    logLine(
      `${msg.phase} ${msg.current}/${msg.total}${msg.detail ? ` — ${msg.detail}` : ""}`
    );
  }
  if (msg.type === "INDEX_DONE") {
    setIndexing(false);
    if (msg.ok) {
      logLine(`Done. Indexed (reported): ${msg.indexed}`);
    } else {
      logLine(`Error: ${msg.error || "unknown"}`);
    }
  }
});

btnFull.addEventListener("click", () => {
  const ok = window.confirm(
    "Full index will fetch and embed all bookmarks, replacing the local RAG index.\n\nContinue?"
  );
  if (!ok) return;
  indexLog.textContent = "";
  setIndexing(true);
  logLine("Starting full index…");
  chrome.runtime.sendMessage({ type: "INDEX_FULL" });
});

btnIncr.addEventListener("click", () => {
  const ok = window.confirm(
    "Incremental index will update only new or changed bookmarks.\n\nContinue?"
  );
  if (!ok) return;
  indexLog.textContent = "";
  setIndexing(true);
  logLine("Starting incremental index…");
  chrome.runtime.sendMessage({ type: "INDEX_INCREMENTAL" });
});

btnTest.addEventListener("click", () => {
  const ok = window.confirm(
    "Test (100) will fetch and embed only the first 100 bookmarks, replacing the local RAG index.\n\nContinue?"
  );
  if (!ok) return;
  indexLog.textContent = "";
  setIndexing(true);
  logLine("Starting test index (first 100 bookmarks)…");
  chrome.runtime.sendMessage({ type: "INDEX_TEST" });
});

function renderAnswer(html: string) {
  answerEl.innerHTML = html;
  answerEl.querySelectorAll("a[href]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = (a as HTMLAnchorElement).href;
      if (href.startsWith("http://") || href.startsWith("https://")) {
        e.preventDefault();
        chrome.tabs.create({ url: href, active: true });
      }
    });
  });
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkifyEscapedText(s: string): string {
  const placeholders: string[] = [];

  // 1) Markdown links: [label](https://example.com)
  let out = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const token = `__LINK_TOKEN_${placeholders.length}__`;
    placeholders.push(
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    );
    return token;
  });

  // 2) Plain URLs with scheme or www.
  out = out.replace(/(?:https?:\/\/|www\.)[^\s<>"']+/g, (raw) => {
    let shown = raw;
    let suffix = "";
    while (/[.,!?)]$/.test(shown)) {
      suffix = shown.slice(-1) + suffix;
      shown = shown.slice(0, -1);
    }
    const href = shown.startsWith("www.") ? `https://${shown}` : shown;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${shown}</a>${suffix}`;
  });

  // 3) Restore markdown-link placeholders.
  out = out.replace(/__LINK_TOKEN_(\d+)__/g, (_m, idx) => {
    const n = Number(idx);
    return Number.isFinite(n) && placeholders[n] ? placeholders[n] : _m;
  });

  return out;
}

btnAsk.addEventListener("click", () => {
  const q = queryEl.value.trim();
  answerEl.innerHTML = "";
  citationsEl.innerHTML = "";
  if (!q) return;
  btnAsk.disabled = true;
  chrome.runtime.sendMessage({ type: "QUERY", query: q }, (res: BgResponse) => {
    btnAsk.disabled = false;
    const err = chrome.runtime.lastError;
    if (err) {
      answerEl.innerHTML = `<span class="err">${err.message}</span>`;
      return;
    }
    if (!res) {
      answerEl.innerHTML = `<span class="err">No response</span>`;
      return;
    }
    if (res.type === "QUERY_DONE") {
      if (!res.ok) {
        answerEl.innerHTML = `<span class="err">${escapeHtml(res.error || "Error")}</span>`;
        return;
      }
      const text = res.answer || "";
      const safe = linkifyEscapedText(escapeHtml(text)).replace(/\n/g, "<br/>");
      renderAnswer(safe);
      const cites = res.citations || [];
      if (cites.length) {
        const h = document.createElement("h3");
        h.textContent = "Bookmarks";
        citationsEl.appendChild(h);
        cites.forEach((c, i) => {
          const a = document.createElement("a");
          a.href = c.url;
          a.className = "citation-link";
          a.textContent = `${i + 1}. ${c.title || c.url}`;
          a.title = c.url;
          a.addEventListener("click", (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: c.url, active: true });
          });
          citationsEl.appendChild(a);
        });
      }
    }
  });
});

queryEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    btnAsk.click();
  }
});
