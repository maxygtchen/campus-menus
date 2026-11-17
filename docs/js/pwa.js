/* Register the PWA service worker (safe to load on every page). */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .catch((err) => console.warn("Service worker registration failed:", err));
  });
}