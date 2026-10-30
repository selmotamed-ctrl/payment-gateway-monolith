/**
 * The drop-in Moamalat Lightbox SDK served at `/sdk/moamalat-lightbox.js`.
 *
 * `core-back` seeds this URL (with its SRI hash) into the rail's widget
 * definition; `checkout-front` loads it and calls
 * `window.Lightbox.Checkout.configure(...)`. The script mounts a sandboxed
 * iframe that talks to the fake rails hosted widget over `postMessage`.
 */
export const moamalatLightboxScript = (publicBaseUrl: string): string => `(function () {
  var BASE = ${JSON.stringify(publicBaseUrl.replace(/\/$/, ""))};
  if (window.Lightbox && window.Lightbox.Checkout) return;

  function buildFrameUrl(config) {
    var params = new URLSearchParams();
    Object.keys(config || {}).forEach(function (key) {
      var value = config[key];
      if (typeof value === "function") return;
      if (value === undefined || value === null) return;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    params.set("rail", "moamalat");
    return BASE + "/hosted/widget-frame?" + params.toString();
  }

  function configure(config) {
    var overlay = document.createElement("div");
    overlay.setAttribute("data-fake-rails-lightbox", "true");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:2147483000;";

    var frame = document.createElement("iframe");
    frame.src = buildFrameUrl(config);
    frame.title = "Moamalat secure payment";
    frame.style.cssText = "width:420px;max-width:96vw;height:600px;max-height:94vh;border:0;border-radius:16px;background:#fff;box-shadow:0 24px 80px rgba(0,0,0,.35);";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");

    var close = function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      window.removeEventListener("message", onMessage);
    };

    var onMessage = function (event) {
      if (event.source !== frame.contentWindow) return;
      var data = event.data || {};
      if (data.type === "fake-rails:complete") {
        close();
        if (typeof config.completeCallback === "function") config.completeCallback(data.payload || data);
      } else if (data.type === "fake-rails:error") {
        close();
        if (typeof config.errorCallback === "function") config.errorCallback(data.payload || data);
      } else if (data.type === "fake-rails:cancel") {
        close();
        if (typeof config.cancelCallback === "function") config.cancelCallback(data.payload || data);
      }
    };

    window.addEventListener("message", onMessage);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  }

  window.Lightbox = window.Lightbox || {};
  window.Lightbox.Checkout = window.Lightbox.Checkout || {};
  window.Lightbox.Checkout.configure = configure;
  window.Lightbox.Checkout.open = configure;
  window.dispatchEvent(new Event("fake-rails:moamalat-ready"));
})();
`;
