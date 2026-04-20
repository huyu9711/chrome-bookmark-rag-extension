import type { BgResponse } from "../lib/types";

const indexLog = document.getElementById("index-log")!;
const btnFull = document.getElementById("btn-full") as HTMLButtonElement;
const btnIncr = document.getElementById("btn-incr") as HTMLButtonElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnSkip = document.getElementById("btn-skip") as HTMLButtonElement;
const btnAsk = document.getElementById("btn-ask") as HTMLButtonElement;
const queryEl = document.getElementById("query") as HTMLTextAreaElement;
const answerEl = document.getElementById("answer")!;
const citationsEl = document.getElementById("citations")!;
const keepAlivePort = chrome.runtime.connect({ name: "index-keepalive" });
let keepAliveTimer: number | undefined;

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
  btnSkip.disabled = !busy;
  if (busy) {
    if (keepAliveTimer == null) {
      keepAliveTimer = window.setInterval(() => {
        keepAlivePort.postMessage({ type: "PING", t: Date.now() });
      }, 20_000);
    }
  } else if (keepAliveTimer != null) {
    window.clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}

setIndexing(false);

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

btnSkip.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "INDEX_SKIP_CURRENT" });
  logLine("Requested: skip current embedding batch.");
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

function applyInlineMarkdown(escaped: string): string {
  const codeTokens: string[] = [];
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
    const token = `__CODE_TOKEN_${codeTokens.length}__`;
    codeTokens.push(`<code>${code}</code>`);
    return token;
  });

  const linkTokens: string[] = [];
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    const token = `__LINK_TOKEN_${linkTokens.length}__`;
    linkTokens.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return token;
  });

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

  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");

  out = out.replace(/__LINK_TOKEN_(\d+)__/g, (_m, idx) => {
    const n = Number(idx);
    return Number.isFinite(n) && linkTokens[n] ? linkTokens[n] : _m;
  });
  out = out.replace(/__CODE_TOKEN_(\d+)__/g, (_m, idx) => {
    const n = Number(idx);
    return Number.isFinite(n) && codeTokens[n] ? codeTokens[n] : _m;
  });

  return out;
}

function markdownToHtml(text: string): string {
  let escaped = escapeHtml(text).replace(/\r\n/g, "\n").trim();
  if (!escaped) return "";

  const blockTokens: string[] = [];
  escaped = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const token = `__BLOCK_TOKEN_${blockTokens.length}__`;
    const cls = lang ? ` class="lang-${lang}"` : "";
    blockTokens.push(`<pre><code${cls}>${code}</code></pre>`);
    return token;
  });

  const blocks = escaped.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const htmlBlocks = blocks.map((block) => {
    if (/^__BLOCK_TOKEN_\d+__$/.test(block)) {
      return block;
    }

    const heading = block.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      return `<h${level}>${applyInlineMarkdown(heading[2])}</h${level}>`;
    }

    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      const items = lines
        .map((line) => line.replace(/^\s*[-*]\s+/, ""))
        .map((item) => `<li>${applyInlineMarkdown(item)}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }

    if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
      const items = lines
        .map((line) => line.replace(/^\s*\d+\.\s+/, ""))
        .map((item) => `<li>${applyInlineMarkdown(item)}</li>`)
        .join("");
      return `<ol>${items}</ol>`;
    }

    if (lines.every((line) => /^\s*>\s?/.test(line))) {
      const content = lines.map((line) => line.replace(/^\s*>\s?/, "")).join("<br/>");
      return `<blockquote>${applyInlineMarkdown(content)}</blockquote>`;
    }

    return `<p>${applyInlineMarkdown(block).replace(/\n/g, "<br/>")}</p>`;
  });

  let out = htmlBlocks.join("\n");
  out = out.replace(/__BLOCK_TOKEN_(\d+)__/g, (_m, idx) => {
    const n = Number(idx);
    return Number.isFinite(n) && blockTokens[n] ? blockTokens[n] : _m;
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
      renderAnswer(markdownToHtml(text));
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

window.addEventListener("beforeunload", () => {
  if (keepAliveTimer != null) {
    window.clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
  keepAlivePort.disconnect();
});
