/** Static print-preview stylesheet for the A4 chrome Studio preview. */
export const CHROME_PREVIEW_CSS = `.chrome-preview-shell{padding:18px;background:#dfe6ec;display:flex;justify-content:center}
 .chrome-preview-frame{width:calc(210mm * .78);height:calc(297mm * .78);position:relative}
 .chrome-preview-page{position:absolute;top:0;left:0;width:210mm;height:297mm;background:#fff;overflow:hidden;transform:scale(.78);transform-origin:top left;box-shadow:0 12px 30px rgba(15,23,42,.16)}
 .chrome-preview-header{position:absolute;top:2mm;left:14mm;right:14mm;height:22mm}
 .chrome-preview-footer{position:absolute;bottom:4mm;left:14mm;right:14mm;height:16mm}
 .chrome-preview-body{position:absolute;top:26mm;left:14mm;right:14mm;bottom:24mm;padding-top:5mm;color:#1f2d3d;font-family:Arial,'Noto Sans Arabic',sans-serif}
 .cp-eyebrow{font-size:7pt;font-weight:700;letter-spacing:1.4pt;text-transform:uppercase;color:#0b5d7a}
 .chrome-preview-body h1{font-size:24pt;line-height:1.05;margin:4mm 0 3mm;color:#0d3b66}
 .cp-lede{font-size:9pt;line-height:1.45;color:#5b6b7a;max-width:135mm;margin:0 0 7mm}
 .cp-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm}
 .cp-kpi{border:0.3mm solid #d9e4ea;border-inline-start:1.2mm solid #0b5d7a;border-radius:2.6mm;padding:4mm;background:#f7fafb}
 .cp-kpi:nth-child(2){border-inline-start-color:#2e8b57}.cp-kpi:nth-child(3){border-inline-start-color:#e67e22}
 .cp-kpi span{display:block;font-size:6.4pt;letter-spacing:.7pt;text-transform:uppercase;color:#6b7c8c}
 .cp-kpi strong{display:block;margin-top:2mm;font-size:15pt;color:#0d3b66}
 .cp-card{margin-top:7mm;border:0.3mm solid #d9e4ea;border-radius:3mm;padding:5mm}
 .cp-card-head{display:flex;justify-content:space-between;gap:4mm;font-size:7pt;color:#8a99a8;margin-bottom:3mm}
 .cp-card-head strong{font-size:9pt;color:#0d3b66}
 .cp-row{display:flex;justify-content:space-between;padding:2.4mm 0;border-bottom:0.2mm solid #eef5f8;font-size:7.4pt}
 .cp-row:last-child{border-bottom:0}.cp-ok{color:#1e6b43;font-weight:700}.cp-warn{color:#7a4b00;font-weight:700}`;
