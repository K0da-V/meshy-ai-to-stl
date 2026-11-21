const linksList = document.getElementById("links");
const preview = document.getElementById("preview");
const previewImage = document.getElementById("preview-image");
const previewEmpty = document.getElementById("preview-empty");
const formatSelect = document.getElementById("format");
const scanButton = document.getElementById("scan");
const convertButton = document.getElementById("convert");
const urlInput = document.getElementById("url-input");
const downloadUrlButton = document.getElementById("download-url");
const statusEl = document.getElementById("status");
const progress = document.getElementById("progress");
const sandboxFrame = document.getElementById("sandbox");

let jobId = 0;
let selectedUrl = "";
let previewUrls = [];

function setBusy(isBusy, text) {
  scanButton.disabled = isBusy;
  convertButton.disabled = isBusy;
  downloadUrlButton.disabled = isBusy;
  progress.hidden = !isBusy;
  statusEl.textContent = text;
}

function baseNameFromUrl(value) {
  try {
    const path = new URL(value).pathname.split("/").pop() || "model";
    const decoded = decodeURIComponent(path).replace(/\.(?:meshy|glb|gltf)$/i, "");
    return decoded.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "model";
  } catch {
    return "model";
  }
}

function isMeshyUrl(value) {
  return /\.meshy(?:$|[?&])/i.test(value) || value.includes("misc/cdn-models");
}

function isGlbBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  return bytes.length >= 4 && new TextDecoder().decode(bytes.subarray(0, 4)) === "glTF";
}

function isModelLink(url) {
  if (/\.(?:png|jpg|jpeg|webp|gif|svg|mp4|webm)(?:$|[?#])/i.test(url)) return false;
  return /\.(?:glb|gltf|meshy)(?:$|[?#])/i.test(url)
    || /(?:tripo-data\.|data\.tripo3d\.|\.cloudfront\.net)/i.test(url)
    || /(?:pbr_model|base_model|model|download|export)/i.test(url);
}

function isLikelyModelDownload(url) {
  return isModelLink(url) && !/\.(?:png|jpg|jpeg|webp|gif|svg|mp4|webm)(?:$|[?#])/i.test(url);
}

function scanPageForModelLinks() {
  const urls = new Set();
  const add = (value) => {
    if (!value || typeof value !== "string") return;
    try {
      const url = new URL(value, location.href);
      const clean = url.href.split("#")[0];
      const isMeshy = /\.meshy(?:$|[?&])/i.test(clean) || clean.includes("misc/cdn-models");
      const isAsset = /\.(?:glb|gltf|stl|obj|fbx|3mf|usdz|ply|dae|zip)(?:$|[?&])/i.test(clean);
      const isTripo = /(?:^|\.)tripo3d\.ai$/i.test(url.hostname)
        && /(?:model|task|download|output|export)/i.test(url.pathname)
        && url.href !== location.href;
      if (isMeshy || isAsset || isTripo) urls.add(url.href);
    } catch {
      // Ignore invalid URLs.
    }
  };

  performance.getEntriesByType("resource").forEach((entry) => add(entry.name));
  document.querySelectorAll("a[href]").forEach((el) => add(el.getAttribute("href")));
  document.querySelectorAll("[src]").forEach((el) => add(el.getAttribute("src")));
  document.querySelectorAll("[data-src],[data-url],[data-model-url]").forEach((el) => {
    add(el.getAttribute("data-src"));
    add(el.getAttribute("data-url"));
    add(el.getAttribute("data-model-url"));
  });
  for (const match of document.documentElement.innerHTML.matchAll(/https?:\/\/[^"'<>\\\s]+(?:\.meshy|\.(?:glb|gltf|stl|obj|fbx|3mf)|misc\/cdn-models|model_url)[^"'<>\\\s]*/gi)) {
    add(match[0]);
  }

  return [...urls].slice(0, 80);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Could not access the current tab.");
  return tab;
}

async function getLinksFromActiveTab() {
  const tab = await getActiveTab();
  const all = new Set();
  const remembered = await chrome.runtime.sendMessage({ type: "get-model-requests", tabId: tab.id }).catch(() => null);
  for (const link of remembered?.links || []) all.add(link);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "scan-model-links" });
    for (const link of response?.links || []) all.add(link);
  } catch {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanPageForModelLinks,
    });
    for (const link of result?.result || []) all.add(link);
  }

  return { tab, links: [...all].slice(0, 80), previews: remembered?.previews || [] };
}

function fillLinks(links) {
  linksList.replaceChildren();
  for (const link of links) {
    const item = document.createElement("div");
    item.className = `model-link${isModelLink(link) ? " is-3d" : ""}`;
    item.textContent = link;
    item.title = link;
    item.dataset.url = link;
    item.setAttribute("role", "option");
    item.addEventListener("click", () => {
      selectedUrl = link;
      urlInput.value = link;
      linksList.querySelectorAll(".model-link").forEach((entry) => entry.classList.toggle("selected", entry === item));
    });
    item.addEventListener("mouseenter", () => showPreview(link));
    linksList.append(item);
  }
  if (links.length) {
    selectedUrl = links[0];
    linksList.firstElementChild.classList.add("selected");
    showPreview(links[0]);
  }
}

function showPreview(url) {
  const candidate = /\.(?:png|jpg|jpeg|webp)(?:$|[?#])/i.test(url) ? url : previewUrls[0];
  preview.hidden = false;
  if (!candidate) {
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    return;
  }
  previewImage.hidden = false;
  previewEmpty.hidden = true;
  previewImage.src = candidate;
  previewImage.onerror = () => {
    previewImage.hidden = true;
    previewEmpty.hidden = false;
  };
}

function downloadBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    chrome.downloads.download({ url: objectUrl, filename, conflictAction: "uniquify", saveAs: false }, (downloadId) => {
      const error = chrome.runtime.lastError;
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      if (error) reject(new Error(error.message));
      else resolve(downloadId);
    });
  });
}

function convertInSandbox(buffer, format, baseName = "model") {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    const onMessage = (event) => {
      if (event.source !== sandboxFrame.contentWindow || event.data?.id !== id) return;
      window.removeEventListener("message", onMessage);
      if (event.data.ok) resolve(event.data.output);
      else reject(new Error(event.data.error || "Conversion failed"));
    };
    window.addEventListener("message", onMessage);
    sandboxFrame.contentWindow.postMessage({ type: "convert", id, format, baseName, buffer }, "*", [buffer]);
  });
}

async function fetchArrayBuffer(url) {
  const response = await fetch(url, { credentials: "include", redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

async function downloadObjPackage(url) {
  const buffer = await fetchArrayBuffer(url);
  if (!isGlbBuffer(buffer)) throw new Error("The detected model resource did not return a valid GLB.");
  const baseName = baseNameFromUrl(url);
  const output = await convertInSandbox(buffer, "obj-package", baseName);
  for (const file of output.files || []) {
    const blob = new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" });
    await downloadBlob(blob, `Tripo3D/${baseName}/${file.name}`);
  }
}

async function autoDownloadModel(tabId, url) {
  const claim = await chrome.runtime.sendMessage({ type: "claim-auto-download", tabId, url }).catch(() => null);
  if (!claim?.shouldDownload) return;
  try {
    statusEl.textContent = "Modelo detectado. Baixando OBJ, MTL, UV e texturas...";
    await downloadObjPackage(url);
    statusEl.textContent = "Pacote OBJ baixado em Tripo3D/<modelo>/.";
  } catch (error) {
    statusEl.textContent = `Modelo detectado, mas o pacote automático falhou: ${error.message}`;
  }
}

async function scan() {
  try {
    setBusy(true, "Searching for Meshy/Tripo3D model files in the current tab...");
    const result = await getLinksFromActiveTab();
    previewUrls = result.previews;
    fillLinks(result.links);
    statusEl.textContent = result.links.length
      ? `${result.links.length} model file(s) found.`
      : "No supported model found. Reload the page with the extension installed and try again.";
    const candidate = result.links.find(isLikelyModelDownload);
    if (candidate && /(?:^|\.)tripo3d\.ai$/i.test(new URL(result.tab.url).hostname)) {
      autoDownloadModel(result.tab.id, candidate);
    }
  } catch (error) {
    statusEl.textContent = `Scan error: ${error.message}`;
  } finally {
    setBusy(false, statusEl.textContent);
  }
}

scanButton.addEventListener("click", scan);

formatSelect.addEventListener("change", () => {
  convertButton.textContent = `Download ${formatSelect.value.toUpperCase()}`;
});

convertButton.addEventListener("click", async () => {
  const url = selectedUrl;
  if (!url) {
    statusEl.textContent = "No model file selected.";
    return;
  }

  try {
    const format = formatSelect.value;
    setBusy(true, "Downloading model...");
    const buffer = await fetchArrayBuffer(url);
    if (!isMeshyUrl(url) && !isGlbBuffer(buffer)) {
      throw new Error("The selected resource is not a GLB model. Scan again and select the Tripo3D model download, not an API or preview resource.");
    }
    if (format === "obj-package") {
      setBusy(true, "Generating OBJ, MTL, UV and textures...");
      const output = await convertInSandbox(buffer, format, baseNameFromUrl(url));
      for (const file of output.files || []) {
        await downloadBlob(new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" }), `Tripo3D/${baseNameFromUrl(url)}/${file.name}`);
      }
      statusEl.textContent = "OBJ package generated.";
      return;
    }
    setBusy(true, format === "glb" ? "Preparing GLB..." : `Decoding and converting to ${format.toUpperCase()}...`);
    const output = await convertInSandbox(buffer, format, baseNameFromUrl(url));
    const mimeTypes = { stl: "model/stl", obj: "model/obj", glb: "model/gltf-binary" };
    await downloadBlob(new Blob([output], { type: mimeTypes[format] }), `${baseNameFromUrl(url)}.${format}`);
    statusEl.textContent = `${format.toUpperCase()} generated.`;
  } catch (error) {
    statusEl.textContent = `Error: ${error.message}`;
  } finally {
    setBusy(false, statusEl.textContent);
  }
});

downloadUrlButton.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    statusEl.textContent = "Informe uma URL HTTP/HTTPS válida.";
    return;
  }

  try {
    const format = formatSelect.value;
    setBusy(true, "Baixando URL direta...");
    const buffer = await fetchArrayBuffer(url);
    if (!isMeshyUrl(url) && !isGlbBuffer(buffer)) {
      throw new Error("A URL não retornou um GLB válido. Use o link direto do modelo, não uma textura ou endpoint de API.");
    }
    const baseName = baseNameFromUrl(url);
    if (format === "obj-package") {
      setBusy(true, "Gerando OBJ, MTL, UV e texturas...");
      const output = await convertInSandbox(buffer, format, baseName);
      for (const file of output.files || []) {
        await downloadBlob(new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" }), `Tripo3D/${baseName}/${file.name}`);
      }
      statusEl.textContent = "Pacote OBJ baixado.";
    } else {
      setBusy(true, `Convertendo para ${format.toUpperCase()}...`);
      const output = await convertInSandbox(buffer, format, baseName);
      const mimeTypes = { stl: "model/stl", obj: "text/plain", glb: "model/gltf-binary" };
      await downloadBlob(new Blob([output], { type: mimeTypes[format] }), `${baseName}.${format}`);
      statusEl.textContent = `${format.toUpperCase()} baixado.`;
    }
  } catch (error) {
    statusEl.textContent = `Erro no download por URL: ${error.message}`;
  } finally {
    setBusy(false, statusEl.textContent);
  }
});

document.addEventListener("DOMContentLoaded", scan);
