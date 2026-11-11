import type { z } from "zod";
import type { VectorDrawSectionSchema } from "../types/reportSpec";
import { sanitizeReportHtml } from "../sanitizer/ClientDomSanitizer";

export type VectorDrawSection = z.infer<typeof VectorDrawSectionSchema>;

export function renderVectorDrawSectionToSvg(params: {
  section: VectorDrawSection;
  datasets: Record<string, Array<Record<string, unknown>>>;
  t: (key: string) => string;
  formatValue: (val: unknown, hint: string) => string;
  isRtl: boolean;
}): string {
  const { section, datasets, t, formatValue, isRtl } = params;
  if (section.draw_kind === "DECLARATIVE_SVG_CANVAS" && section.custom_svg_template) {
    // Author-supplied SVG goes through the same allow-list sanitizer as HTML templates.
    return sanitizeReportHtml(
      section.custom_svg_template.replace(/\{\{\s*\$t\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key: string) =>
        escapeXml(t(key)),
      ),
    );
  }
  const vbWidth = section.view_box.width;
  const vbHeight = section.view_box.height;

  const nodeMap = new Map(section.nodes.map((n) => [n.node_id, n]));
  const mirrorX = (x: number, w: number) => (isRtl ? vbWidth - x - w : x);

  const edgesSvg = section.edges
    .map((edge) => {
      const from = nodeMap.get(edge.from_node_id);
      const to = nodeMap.get(edge.to_node_id);
      if (!from || !to) return "";
      const x1 = mirrorX(from.x, from.width) + (isRtl ? 0 : from.width);
      const y1 = from.y + from.height / 2;
      const x2 = mirrorX(to.x, to.width) + (isRtl ? to.width : 0);
      const y2 = to.y + to.height / 2;
      const midX = (x1 + x2) / 2;
      const dashAttr =
        edge.style === "DASHED"
          ? 'stroke-dasharray="6,4"'
          : edge.style === "DOTTED"
            ? 'stroke-dasharray="2,3"'
            : "";
      const labelMarkup = edge.label_i18n_key
        ? `<text x="${midX}" y="${Math.min(y1, y2) - 6}" text-anchor="middle" font-size="10" fill="#475569">${escapeXml(t(edge.label_i18n_key))}</text>`
        : "";
      return `<g class="draw-edge">
        <path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${edge.color_hex}" stroke-width="1.75" ${dashAttr} marker-end="url(#report-arrow)" />
        ${labelMarkup}
      </g>`;
    })
    .join("\n");

  const nodesSvg = section.nodes
    .map((node) => {
      const nx = mirrorX(node.x, node.width);
      const ny = node.y;
      const rx = node.shape === "PILL" ? node.height / 2 : node.shape === "ROUNDED_RECT" ? 8 : 2;
      let boundValueText = "";
      if (node.value_binding) {
        const rows = datasets[node.value_binding.dataset_id] ?? [];
        const rawVal = rows[node.value_binding.row_index]?.[node.value_binding.field];
        boundValueText = formatValue(rawVal, node.value_binding.format_hint);
      }
      const shapeMarkup = node.shape === "CIRCLE"
        ? `<ellipse cx="${node.width / 2}" cy="${node.height / 2}" rx="${node.width / 2}" ry="${node.height / 2}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`
        : node.shape === "DIAMOND"
          ? `<polygon points="${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`
          : `<rect width="${node.width}" height="${node.height}" rx="${rx}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`;
      return `<g class="draw-node" transform="translate(${nx}, ${ny})">
        ${shapeMarkup}
        <text x="${node.width / 2}" y="${boundValueText ? node.height * 0.42 : node.height * 0.55}" text-anchor="middle" font-size="11" font-weight="600" fill="${node.text_hex}">${escapeXml(t(node.label_i18n_key))}</text>
        ${
          boundValueText
            ? `<text x="${node.width / 2}" y="${node.height * 0.76}" text-anchor="middle" font-size="12" font-weight="700" fill="${node.stroke_hex}">${escapeXml(boundValueText)}</text>`
            : ""
        }
      </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbWidth} ${vbHeight}" style="width:100%;height:${section.height_mm}mm;display:block;">
    <defs>
      <marker id="report-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#475569" />
      </marker>
    </defs>
    ${edgesSvg}
    ${nodesSvg}
  </svg>`;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
