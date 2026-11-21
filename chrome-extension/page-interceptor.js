(() => {
  "use strict";

  const MAX_DEPTH = 18;
  const MODEL_KEYS = [
    "model_url", "glb_url", "file_url", "download_url", "export_url",
    "result_url", "output_url", "data_url", "mesh_url", "pbr_model",
    "base_model", "model", "asset", "url"
  ];
  const ASSET_EXTENSIONS = [
    "glb", "gltf", "stl", "obj", "fbx", "3mf", "usdz", "usd", "usda",
    "usdc", "ply", "dae", "zip"
  ];
  const NON_ASSET_EXTENSIONS = [
    "png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "svg", "json",
    "js", "css"
  ];
  const ASSET_HOSTS = ["tripo-data.", "data.tripo3d.", ".cloudfront.net"];
  const API_HINTS = ["api.tripo3d.ai", "/api/", "/task/", "/model/", "/export", "/download"];
  const sent = new Set();

  function post(url, source) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    if (sent.has(url)) return;
    sent.add(url);
    if (sent.size > 200) sent.delete(sent.values().next().value);
    window.postMessage({ type: "tripo-model-url", url, source }, "*");
  }

  function postPreview(url, source) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    window.postMessage({ type: "tripo-preview-url", url, source }, "*");
  }

  function extension(url) {
    try {
      const path = new URL(url).pathname.split("/").pop() || "";
      const match = path.match(/\.([a-z0-9]+)$/i);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function isAssetUrl(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
    const lower = url.toLowerCase();
    const ext = extension(url);
    if (NON_ASSET_EXTENSIONS.includes(ext)) return false;
    return ASSET_EXTENSIONS.includes(ext) || ASSET_HOSTS.some((host) => lower.includes(host));
  }

  function isApiUrl(url) {
    if (typeof url !== "string") return false;
    const lower = url.toLowerCase();
    return API_HINTS.some((hint) => lower.includes(hint));
  }

  function safeObject(value) {
    if (!value || typeof value !== "object") return false;
    if (value === window || value === document || value instanceof Node) return false;
    return true;
  }

  function extractText(text, source) {
    if (typeof text !== "string" || text.length > 5_000_000) return;
    const matches = text.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
    for (const value of matches) {
      const url = value.replace(/[),.;]+$/, "");
      if (isAssetUrl(url)) post(url, source);
    }
  }

  function extractObject(value, source, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_DEPTH || !safeObject(value) || seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (["window", "document", "parent", "top", "frames"].includes(key)) continue;
      let child;
      try { child = value[key]; } catch { continue; }
      if (typeof child === "string" && /^https?:\/\//i.test(child)) {
        const keyLooksRelevant = MODEL_KEYS.some((item) => key.toLowerCase().includes(item));
        if (/rendered_image|generated_image|thumbnail|preview/i.test(key)) postPreview(child, `${source}:${key}`);
        if (keyLooksRelevant || isAssetUrl(child)) post(child, `${source}:${key}`);
      } else if (safeObject(child)) {
        extractObject(child, source, depth + 1, seen);
      }
    }
  }

  function scanState(source) {
    try {
      if (window.__NUXT__) extractObject(window.__NUXT__, source);
      if (window.__vue_app__) extractObject(window.__vue_app__, source);
      if (window.$nuxt) extractObject(window.$nuxt, source);
    } catch {}
  }

  function scanDom() {
    try {
      const elements = document.querySelectorAll("a[href], [src], [data-src], [data-url], [data-model-url]");
      for (const element of elements) {
        for (const attribute of ["href", "src", "data-src", "data-url", "data-model-url"]) {
          const value = element.getAttribute(attribute);
          if (isAssetUrl(value)) post(new URL(value, location.href).href, `dom:${attribute}`);
        }
      }
    } catch {}
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === "string" ? request : request?.url;
    if (isAssetUrl(url)) post(url, "fetch-request");
    const result = originalFetch.apply(this, args);
    if (!isApiUrl(url)) return result;
    return result.then((response) => {
      response.clone().text().then((body) => {
        try { extractObject(JSON.parse(body), "fetch-api"); } catch { extractText(body, "fetch-api"); }
      }).catch(() => {});
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tripoUrl = url;
    if (isAssetUrl(url)) post(url, "xhr-request");
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isApiUrl(this.__tripoUrl)) {
      this.addEventListener("load", () => {
        const body = this.responseType === "text" || !this.responseType ? this.responseText : "";
        try { extractObject(JSON.parse(body), "xhr-api"); } catch { extractText(body, "xhr-api"); }
      });
    }
    return originalSend.apply(this, args);
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (isAssetUrl(entry.name)) post(entry.name, "performance");
    });
    observer.observe({ entryTypes: ["resource"] });
  } catch {}

  scanState("initial-state");
  scanDom();
  for (const entry of performance.getEntriesByType("resource")) {
    if (isAssetUrl(entry.name)) post(entry.name, "performance-cache");
  }
  setTimeout(() => { scanState("delayed-state"); scanDom(); }, 1500);
})();
