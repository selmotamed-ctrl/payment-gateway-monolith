//! The drop-in Moamalat Lightbox and MPGS Hosted Session SDK scripts, generated per request with
//! the configured public base URL. Ported from `api/sdk/*` (the JS text is byte-equivalent apart
//! from the injected base URL).

#![forbid(unsafe_code)]

use crate::config::Config;
use crate::crypto::sha384_base64;

pub const MOAMALAT_SCRIPT: &str = "moamalat-lightbox.js";
pub const MPGS_SCRIPT: &str = "mpgs-session.js";

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

#[must_use]
pub fn moamalat_lightbox_script(public_base_url: &str) -> String {
    let base = js_string(public_base_url.trim_end_matches('/'));
    format!(
        r#"(function () {{
  var BASE = {base};
  if (window.Lightbox && window.Lightbox.Checkout) return;

  function buildFrameUrl(config) {{
    var params = new URLSearchParams();
    Object.keys(config || {{}}).forEach(function (key) {{
      var value = config[key];
      if (typeof value === "function") return;
      if (value === undefined || value === null) return;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }});
    params.set("rail", "moamalat");
    return BASE + "/hosted/widget-frame?" + params.toString();
  }}

  function configure(config) {{
    var overlay = document.createElement("div");
    overlay.setAttribute("data-fake-rails-lightbox", "true");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:2147483000;";

    var frame = document.createElement("iframe");
    frame.src = buildFrameUrl(config);
    frame.title = "Moamalat secure payment";
    frame.style.cssText = "width:420px;max-width:96vw;height:600px;max-height:94vh;border:0;border-radius:16px;background:#fff;box-shadow:0 24px 80px rgba(0,0,0,.35);";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");

    var close = function () {{
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      window.removeEventListener("message", onMessage);
    }};

    var onMessage = function (event) {{
      if (event.source !== frame.contentWindow) return;
      var data = event.data || {{}};
      if (data.type === "fake-rails:complete") {{
        close();
        if (typeof config.completeCallback === "function") config.completeCallback(data.payload || data);
      }} else if (data.type === "fake-rails:error") {{
        close();
        if (typeof config.errorCallback === "function") config.errorCallback(data.payload || data);
      }} else if (data.type === "fake-rails:cancel") {{
        close();
        if (typeof config.cancelCallback === "function") config.cancelCallback(data.payload || data);
      }}
    }};

    window.addEventListener("message", onMessage);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  }}

  window.Lightbox = window.Lightbox || {{}};
  window.Lightbox.Checkout = window.Lightbox.Checkout || {{}};
  window.Lightbox.Checkout.configure = configure;
  window.Lightbox.Checkout.open = configure;
  window.dispatchEvent(new Event("fake-rails:moamalat-ready"));
}})();
"#
    )
}

#[must_use]
pub fn mpgs_session_script(public_base_url: &str) -> String {
    let base = js_string(public_base_url.trim_end_matches('/'));
    format!(
        r#"(function () {{
  var BASE = {base};
  if (window.PaymentSession) return;

  function configure(config) {{
    var params = new URLSearchParams();
    Object.keys(config || {{}}).forEach(function (key) {{
      var value = config[key];
      if (typeof value === "function") return;
      if (value === undefined || value === null) return;
      params.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }});
    params.set("rail", "mpgs");
    params.set("threeDS", "challenge");

    var frame = document.createElement("iframe");
    frame.src = BASE + "/hosted/widget-frame?" + params.toString();
    frame.title = "MPGS 3-D Secure";
    frame.style.cssText = "width:440px;max-width:96vw;height:620px;border:0;background:#fff;";
    var container = config.containerId ? document.getElementById(config.containerId) : document.body;
    if (container) {{
      container.innerHTML = "";
      container.appendChild(frame);
    }}

    window.addEventListener("message", function (event) {{
      if (event.source !== frame.contentWindow) return;
      var data = event.data || {{}};
      if (data.type === "fake-rails:complete" && typeof config.completeCallback === "function") {{
        config.completeCallback(data.payload || data);
      }}
      if (data.type === "fake-rails:error" && typeof config.errorCallback === "function") {{
        config.errorCallback(data.payload || data);
      }}
      if (data.type === "fake-rails:cancel" && typeof config.cancelCallback === "function") {{
        config.cancelCallback(data.payload || data);
      }}
    }});
  }}

  window.PaymentSession = {{ configure: configure, showLightbox: configure }};
  window.dispatchEvent(new Event("fake-rails:mpgs-ready"));
}})();
"#
    )
}

#[must_use]
pub fn sdk_script(config: &Config, name: &str) -> Option<String> {
    match name {
        MOAMALAT_SCRIPT => Some(moamalat_lightbox_script(&config.public_base_url)),
        MPGS_SCRIPT => Some(mpgs_session_script(&config.public_base_url)),
        _ => None,
    }
}

/// `sha384-<base64>` SRI hash, exposed for the seeder.
#[must_use]
pub fn sri_hash(config: &Config, name: &str) -> String {
    sdk_script(config, name).map_or_else(String::new, |script| {
        format!("sha384-{}", sha384_base64(script.as_bytes()))
    })
}

#[must_use]
pub fn sdk_list(config: &Config) -> Vec<serde_json::Value> {
    [MOAMALAT_SCRIPT, MPGS_SCRIPT]
        .iter()
        .map(|name| serde_json::json!({ "name": name, "sri": sri_hash(config, name) }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lightbox_script_mounts_the_documented_api() {
        let script = moamalat_lightbox_script("http://127.0.0.1:8444/");
        assert!(script.contains("Lightbox.Checkout.configure"));
        assert!(script.contains("var BASE = \"http://127.0.0.1:8444\""));
        assert!(script.contains("fake-rails:complete"));
    }

    #[test]
    fn mpgs_script_uses_the_challenge_rail() {
        let script = mpgs_session_script("http://127.0.0.1:8444");
        assert!(script.contains("PaymentSession"));
        assert!(script.contains("params.set(\"rail\", \"mpgs\")"));
        assert!(script.contains("threeDS"));
    }

    #[test]
    fn sri_is_stable_and_prefixed() {
        let config = Config::test_config("/tmp/sdk.sqlite");
        let first = sri_hash(&config, MOAMALAT_SCRIPT);
        assert!(first.starts_with("sha384-"));
        assert_eq!(first, sri_hash(&config, MOAMALAT_SCRIPT));
        assert!(sri_hash(&config, "nope.js").is_empty());
        assert_eq!(sdk_list(&config).len(), 2);
    }
}
