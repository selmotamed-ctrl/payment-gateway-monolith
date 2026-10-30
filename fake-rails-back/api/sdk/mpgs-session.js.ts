/**
 * The MPGS Hosted Session SDK served at `/sdk/mpgs-session.js`.
 *
 * It exposes `PaymentSession.configure({...})` and mounts the 3DS2 challenge
 * iframe of the emulator.
 */
export const mpgsSessionScript = (publicBaseUrl: string): string => `(function () {
  var BASE = ${JSON.stringify(publicBaseUrl.replace(/\/$/, ""))};
  if (window.PaymentSession) return;

  function configure(config) {
    var params = new URLSearchParams();
    Object.keys(config || {}).forEach(function (key) {
      var value = config[key];
      if (typeof value === "function") return;
      if (value === undefined || value === null) return;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    });
    params.set("rail", "mpgs");
    params.set("threeDS", "challenge");

    var frame = document.createElement("iframe");
    frame.src = BASE + "/hosted/widget-frame?" + params.toString();
    frame.title = "MPGS 3-D Secure";
    frame.style.cssText = "width:440px;max-width:96vw;height:620px;border:0;background:#fff;";
    var container = config.containerId ? document.getElementById(config.containerId) : document.body;
    if (container) {
      container.innerHTML = "";
      container.appendChild(frame);
    }

    window.addEventListener("message", function (event) {
      if (event.source !== frame.contentWindow) return;
      var data = event.data || {};
      if (data.type === "fake-rails:complete" && typeof config.completeCallback === "function") {
        config.completeCallback(data.payload || data);
      }
      if (data.type === "fake-rails:error" && typeof config.errorCallback === "function") {
        config.errorCallback(data.payload || data);
      }
      if (data.type === "fake-rails:cancel" && typeof config.cancelCallback === "function") {
        config.cancelCallback(data.payload || data);
      }
    });
  }

  window.PaymentSession = { configure: configure, showLightbox: configure };
  window.dispatchEvent(new Event("fake-rails:mpgs-ready"));
})();
`;
