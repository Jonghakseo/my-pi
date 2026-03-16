export function setupPwa(): void {
  if (window.location.protocol !== "https:") {
    return;
  }

  const manifest = {
    name: "pi remote",
    short_name: "pi remote",
    start_url: ".",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      {
        src: `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="#111"/><text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" font-size="170" fill="#e7e7e7">π</text></svg>`,
        )}`,
        sizes: "256x256",
        type: "image/svg+xml",
      },
    ],
  };

  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
  const manifestUrl = URL.createObjectURL(manifestBlob);

  let manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!manifestLink) {
    manifestLink = document.createElement("link");
    manifestLink.rel = "manifest";
    document.head.appendChild(manifestLink);
  }
  manifestLink.href = manifestUrl;

  if (!("serviceWorker" in navigator)) {
    return;
  }

  const swSource = `
    self.addEventListener("install", (event) => {
      event.waitUntil(self.skipWaiting());
    });
    self.addEventListener("activate", (event) => {
      event.waitUntil(self.clients.claim());
    });
    self.addEventListener("fetch", () => {});
  `;
  const swBlob = new Blob([swSource], { type: "text/javascript" });
  const swUrl = URL.createObjectURL(swBlob);

  navigator.serviceWorker.register(swUrl).catch(() => {
    // ignore optional PWA failure
  });
}
