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


  /**
   * Paged.js removes the author @page rules while rendering. Re-inject the
   * paper-size rules after pagination so Chrome's print/PDF path can honour
   * mixed portrait/landscape pages.
   */
  function ensurePrintPageRules() {
    if (document.getElementById("report-print-page-rules")) return;
    var body = document.body;
    if (!body) return;
    var width = Number(body.getAttribute("data-report-paper-width") || 210);
    var height = Number(body.getAttribute("data-report-paper-height") || 297);
    if (!width || !height) return;
    var marginTop = body.getAttribute("data-report-margin-top") || "0";
    var marginRight = body.getAttribute("data-report-margin-right") || "0";
    var marginBottom = body.getAttribute("data-report-margin-bottom") || "0";
    var marginLeft = body.getAttribute("data-report-margin-left") || "0";
    var style = document.createElement("style");
    style.id = "report-print-page-rules";
    style.textContent = [
      "@page { size: " + width + "mm " + height + "mm; margin: 0; }",
      "@page portrait { size: " + width + "mm " + height + "mm; margin: 0; }",
      "@page landscape { size: " + height + "mm " + width + "mm; margin: 0; }",
      ".pagedjs_page.pagedjs_landscape_page { page: landscape; }",
      ".pagedjs_page.pagedjs_portrait_page { page: portrait; }",
      "@media print { .pagedjs_page.pagedjs_landscape_page { page: landscape !important; } .pagedjs_page.pagedjs_portrait_page { page: portrait !important; } }",
      "@media print { .pagedjs_page { break-before: page !important; break-after: auto !important; } .pagedjs_page:first-child { break-before: auto !important; } }",
      "@media print { .pagedjs_page.pagedjs_landscape_page, .pagedjs_page.pagedjs_landscape_page > .pagedjs_sheet, .pagedjs_page.pagedjs_landscape_page .pagedjs_pagebox { width: " + height + "mm !important; height: " + width + "mm !important; max-height: none !important; } .pagedjs_page.pagedjs_portrait_page, .pagedjs_page.pagedjs_portrait_page > .pagedjs_sheet, .pagedjs_page.pagedjs_portrait_page .pagedjs_pagebox { width: " + width + "mm !important; height: " + height + "mm !important; max-height: none !important; } }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function headerSignature(thead) {
    return Array.prototype.map
      .call(thead.querySelectorAll("th"), function (cell) {
        return (cell.textContent || "").trim();
      })
      .join("|");
  }

  /**
   * Paged.js splits tables into separate page fragments and drops the
   * <thead>. Re-insert the header and colgroup into every continuation
   * fragment (matched by data-ref, with a column-count fallback).
   */
  function repeatTableHeaders() {
    var tables = Array.prototype.slice.call(
      document.querySelectorAll(".pagedjs_page_content table.report-data-table"),
    );
    var originals = Object.create(null);
    var lastByColumnCount = Object.create(null);
    var changed = false;
    tables.forEach(function (table) {
      var ref = table.getAttribute("data-ref");
      var thead = table.querySelector("thead");
      var colgroup = table.querySelector("colgroup");
      var cellCount = table.querySelector("tbody tr") ? table.querySelector("tbody tr").children.length : 0;
      if (thead) {
        var entry = { thead: thead, colgroup: colgroup, signature: headerSignature(thead) };
        if (ref) originals[ref] = entry;
        if (cellCount > 0) lastByColumnCount[cellCount] = entry;
      }
    });
    tables.forEach(function (table) {
      var ref = table.getAttribute("data-ref");
      var thead = table.querySelector("thead");
      if (thead) return;
      var firstRow = table.querySelector("tbody tr") || table.querySelector("tr");
      var cellCount = firstRow ? firstRow.children.length : 0;
      var source = (ref && originals[ref]) || (cellCount > 0 ? lastByColumnCount[cellCount] : null);
      if (!source) return;
      var tbody = table.querySelector("tbody");
      var anchor = tbody || table.firstChild;
      if (source.colgroup && !table.querySelector("colgroup")) {
        table.insertBefore(source.colgroup.cloneNode(true), anchor);
      }
      table.insertBefore(source.thead.cloneNode(true), anchor);
      table.setAttribute("data-header-repeated", ref ? "ref" : "fallback");
      changed = true;
    });
    return changed;
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      repeatTableHeaders();
      count();
    }, 60);
  }

  function afterRender() {
    ensurePrintPageRules();
    repeatTableHeaders();
    count();
  }
  document.addEventListener("pagedjs:rendered", afterRender);
  window.addEventListener("load", function () {
    setTimeout(afterRender, 50);
    setTimeout(afterRender, 400);
    setTimeout(afterRender, 1200);
    setTimeout(afterRender, 2500);
  });
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("message", function (event) {
    if (event && event.data && event.data.type === "report:print") {
      ensurePrintPageRules();
      repeatTableHeaders();
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
