export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const PIXEL_ATTR = "data-omt";

export function pixelUrl(serverUrl: string, id: string) {
  return `${serverUrl}/p/${id}.gif`;
}

export function createPixel(doc: Document, serverUrl: string, id: string) {
  const img = doc.createElement("img");
  img.src = pixelUrl(serverUrl, id);
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.style.cssText = "border:0;width:1px;height:1px";
  img.setAttribute(PIXEL_ATTR, id);
  return img;
}

const isPixel = (img: HTMLImageElement, marker: string) =>
  img.hasAttribute(PIXEL_ATTR) || (img.getAttribute("src") ?? "").includes(marker);

/** True when the element is, or contains, one of our pixels, directly or through Gmail's image proxy. */
export function hasPixel(el: Element, serverUrl: string) {
  const marker = `${new URL(serverUrl).hostname}/p/`;
  if (el instanceof HTMLImageElement) return isPixel(el, marker);
  return [...el.querySelectorAll("img")].some((img) => isPixel(img, marker));
}

/** Removes our pixels, including ones quoted from earlier messages via Gmail's image proxy. */
export function removePixels(root: ParentNode, serverUrl: string) {
  const marker = `${new URL(serverUrl).hostname}/p/`;
  root.querySelectorAll("img").forEach((img) => {
    if (isPixel(img, marker)) img.remove();
  });
}

/** Blocks this tracker’s pixels in this browser profile's Gmail, directly or through Google's proxy. */
export function pixelBlockRule(serverUrl: string): chrome.declarativeNetRequest.Rule {
  const base = new URL(`${serverUrl.replace(/\/$/, "")}/p/`).href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    id: 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      // Leave ID length validation to the server. Expanding {22} exceeds Chrome's compiled-regex limit.
      regexFilter: `^(?:https://[a-z0-9-]+\\.googleusercontent\\.com/[^#]*#)?${base}[A-Za-z0-9_-]+\\.gif$`,
      isUrlFilterCaseSensitive: true,
      initiatorDomains: ["mail.google.com"],
      resourceTypes: ["image"],
    },
  };
}

export function installPixelBlockRule(serverUrl: string) {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [pixelBlockRule(serverUrl)],
  });
}
