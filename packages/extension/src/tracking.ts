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

/** Chrome blocks the pixel from loading inside Gmail itself so composing never counts as an open. */
export function pixelBlockRule(serverUrl: string): chrome.declarativeNetRequest.Rule {
  const host = new URL(serverUrl).hostname;
  return {
    id: 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${host}/p/`,
      initiatorDomains: ["mail.google.com"],
      resourceTypes: ["image"],
    },
  };
}
