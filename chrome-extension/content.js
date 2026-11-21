function injectPageInterceptor() {
  if (!/(?:^|\.)tripo3d\.ai$/i.test(location.hostname)) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-interceptor.js");
  script.onload = () => script.remove();
  const target = document.documentElement || document.head;
  if (target) target.appendChild(script);
  else document.addEventListener("DOMContentLoaded", () => document.documentElement.appendChild(script), { once: true });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "tripo-model-url") return;
  chrome.runtime.sendMessage({ type: "remember-model-url", url: event.data.url }).catch(() => {});
});

injectPageInterceptor();

function isSupportedModelUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const url = new URL(value, location.href);
    const clean = url.href.split("#")[0];
    if (/\.meshy(?:$|[?&])/i.test(clean) || clean.includes("misc/cdn-models")) return true;
    if (/\.(?:glb|gltf)(?:$|[?&])/i.test(clean)) return true;
    return /(?:^|\.)tripo3d\.ai$/i.test(url.hostname)
      && /(?:model|task|download|output)/i.test(url.pathname)
      && url.href !== location.href;
  } catch {
    return false;
  }
}

function collectModelLinks() {
  const urls = new Set();
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value, location.href);
      const clean = url.href.split("#")[0];
      if (isSupportedModelUrl(clean)) {
        urls.add(url.href);
      }
    } catch {
      // Ignore invalid or script-only URLs.
    }
  };

  document.querySelectorAll("a[href]").forEach((el) => add(el.getAttribute("href")));
  document.querySelectorAll("[src]").forEach((el) => add(el.getAttribute("src")));
  document.querySelectorAll("[data-src],[data-url],[data-model-url]").forEach((el) => {
    add(el.getAttribute("data-src"));
    add(el.getAttribute("data-url"));
    add(el.getAttribute("data-model-url"));
  });

  performance.getEntriesByType("resource").forEach((entry) => add(entry.name));

  const html = document.documentElement.innerHTML;
  for (const match of html.matchAll(/https?:\/\/[^"'<>\\\s]+(?:\.meshy|\.glb|\.gltf|misc\/cdn-models|model_url)[^"'<>\\\s]*/gi)) {
    add(match[0]);
  }

  const links = [...urls].slice(0, 50);
  for (const url of links) {
    chrome.runtime.sendMessage({ type: "remember-model-url", url }).catch(() => {});
  }
  return links;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "scan-model-links") return;
  sendResponse({ links: collectModelLinks() });
});
