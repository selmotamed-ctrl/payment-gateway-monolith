(function () {
  var script = document.currentScript;
  var token = (script && script.getAttribute("data-report-token")) || "";
  function post(type, extra) {
    try {
      parent.postMessage(Object.assign({ type: type, token: token }, extra || {}), "*");
    } catch (_) {}
  }
  post("report:bridgeReady");
  function send(pages) {
    post("report:pageCount", { pages: pages });
  }
  function count() {
    var pages = document.querySelectorAll(".pagedjs_page").length;
    if (pages > 0) send(pages);
    return pages;
  }
  document.addEventListener("pagedjs:rendered", count);
  window.addEventListener("load", function () {
    setTimeout(count, 50);
    setTimeout(count, 400);
    setTimeout(count, 1200);
  });
  window.addEventListener("message", function (event) {
    if (event && event.data && event.data.type === "report:print") {
      var print = function () {
        try {
          window.focus();
          window.print();
        } catch (_) {}
      };
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(print).catch(print);
      else print();
    }
  });
})();
