const tabModelRequests = new Map();
const tabPreviewRequests = new Map();
const autoDownloadedModels = new Map();

function isSupportedModelUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const clean = parsed.href.split("#")[0];
    if (/\.meshy(?:$|[?&])/i.test(clean) || clean.includes("misc/cdn-models")) return true;
    if (/\.(?:glb|gltf)(?:$|[?&])/i.test(clean)) return true;
    if (/(?:tripo-data\.|data\.tripo3d\.|\.cloudfront\.net)/i.test(parsed.hostname)) return true;
    return /(?:^|\.)tripo3d\.ai$/i.test(parsed.hostname)
      && /(?:model|task|download|output)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function remember(tabId, url, force = false) {
  if (tabId < 0 || (!force && !isSupportedModelUrl(url))) return;
  const urls = tabModelRequests.get(tabId) || [];
  if (!urls.includes(url)) urls.unshift(url);
  tabModelRequests.set(tabId, urls.slice(0, 50));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === "main_frame") {
      tabModelRequests.delete(details.tabId);
      tabPreviewRequests.delete(details.tabId);
      autoDownloadedModels.delete(details.tabId);
      return;
    }
    remember(details.tabId, details.url);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const contentType = (details.responseHeaders || [])
      .find((header) => header.name.toLowerCase() === "content-type")?.value || "";
    const pageUrl = details.documentUrl || details.initiator || "";
    const isTripoPage = /(?:^|:\/\/)(?:[^/]+\.)?tripo3d\.ai\b/i.test(pageUrl);
    if (/model\/gltf-binary|model\/gltf\+json/i.test(contentType)
      || (isTripoPage && /(?:application|binary)\/octet-stream/i.test(contentType))) {
      remember(details.tabId, details.url, true);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabModelRequests.delete(tabId);
  tabPreviewRequests.delete(tabId);
  autoDownloadedModels.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "remember-model-url" && sender.tab?.id !== undefined) {
    const pageUrl = sender.tab.url || "";
    let fromTripo = false;
    try { fromTripo = /(?:^|\.)tripo3d\.ai$/i.test(new URL(pageUrl).hostname); } catch {}
    remember(sender.tab.id, message.url, fromTripo);
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "get-model-requests") {
    sendResponse({ links: tabModelRequests.get(message.tabId) || [], previews: tabPreviewRequests.get(message.tabId) || [] });
    return;
  }

  if (message?.type === "remember-preview-url" && sender.tab?.id !== undefined) {
    const previews = tabPreviewRequests.get(sender.tab.id) || [];
    if (!previews.includes(message.url)) previews.unshift(message.url);
    tabPreviewRequests.set(sender.tab.id, previews.slice(0, 10));
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "claim-auto-download" && message.tabId !== undefined) {
    const claimed = autoDownloadedModels.get(message.tabId) || new Set();
    const shouldDownload = !claimed.has(message.url);
    claimed.add(message.url);
    autoDownloadedModels.set(message.tabId, claimed);
    sendResponse({ shouldDownload });
  }
});
