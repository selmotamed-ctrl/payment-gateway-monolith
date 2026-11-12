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
      const labelX = x1 + (x2 - x1) * 0.45;
      const hasRoomForLabel = Math.abs(x2 - x1) > 60 || Math.abs(y2 - y1) > 60;
      const labelMarkup = edge.label_i18n_key && hasRoomForLabel
        ? `<text x="${labelX}" y="${Math.min(y1, y2) - 12}" text-anchor="middle" font-size="9" fill="#475569" stroke="#FFFFFF" stroke-width="3" paint-order="stroke">${escapeXml(t(edge.label_i18n_key))}</text>`
        : "";
      return `<g class="draw-edge">
        <path d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" fill="none" stroke="${edge.color_hex}" stroke-width="1.75" ${dashAttr} marker-end="url(#report-arrow)" />
        ${labelMarkup}
      </g>`;
    })
    .join("\n");

  const wrapText = (text: string, size: number, maxWidth: number): string[] => {
    const maxChars = Math.max(1, Math.floor(maxWidth / Math.max(1, size * 0.58)));
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      if (word.length <= maxChars) current = word;
      else {
        for (let index = 0; index < word.length; index += maxChars) {
          const chunk = word.slice(index, index + maxChars);
          if (chunk.length === maxChars) lines.push(chunk);
          else current = chunk;
        }
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [text];
  };

  const layoutNodeText = (label: string, value: string, width: number, height: number, center: boolean) => {
    const padding = Math.max(4, Math.min(9, width * 0.07));
    const maxWidth = Math.max(8, width - padding * 2);
    const longestToken = (text: string): number =>
      Math.max(1, ...text.split(/\s+/).filter(Boolean).map((token) => token.length));
    const fitSize = (text: string, preferred: number): number =>
      Math.max(6, Math.min(preferred, Math.floor(maxWidth / (longestToken(text) * 0.58))));
    let labelSize = fitSize(label, 11);
    let valueSize = value ? fitSize(value, 12) : 12;
    let labelLines: string[] = [];
    let valueLines: string[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      labelLines = wrapText(label, labelSize, maxWidth);
      valueLines = value ? wrapText(value, valueSize, maxWidth) : [];
      const lineHeight = labelSize * 1.22;
      const valueLineHeight = valueSize * 1.22;
      const needed =
        padding * 2 +
        labelLines.length * lineHeight +
        (valueLines.length > 0 ? 4 + valueLines.length * valueLineHeight : 0);
      if (needed <= height) break;
      labelSize = Math.max(6, labelSize - 1);
      valueSize = Math.max(6, valueSize - 1);
      if (labelSize === 6 && valueSize === 6) break;
    }
    const labelLineHeight = labelSize * 1.22;
    const valueLineHeight = valueSize * 1.22;
    const labelStartY = center && valueLines.length === 0 ? height / 2 + labelSize * 0.35 : padding + labelSize;
    const valueStartY = Math.min(
      height - padding - (valueLines.length > 0 ? (valueLines.length - 1) * valueLineHeight : 0),
      height - padding,
    );
    return { labelLines, labelSize, labelStartY, labelLineHeight, valueLines, valueSize, valueStartY, valueLineHeight };
  };

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
      const text = layoutNodeText(
        t(node.label_i18n_key),
        boundValueText,
        node.width,
        node.height,
        node.shape === "CIRCLE" || node.shape === "DIAMOND",
      );
      const shapeMarkup = node.shape === "CIRCLE"
        ? `<ellipse cx="${node.width / 2}" cy="${node.height / 2}" rx="${node.width / 2}" ry="${node.height / 2}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`
        : node.shape === "DIAMOND"
          ? `<polygon points="${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`
          : `<rect width="${node.width}" height="${node.height}" rx="${rx}" fill="${node.fill_hex}" stroke="${node.stroke_hex}" stroke-width="1.5" />`;
      const labelMarkup = text.labelLines
        .map(
          (line, index) =>
            `<tspan x="${node.width / 2}" y="${text.labelStartY + index * text.labelLineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      const valueMarkup = text.valueLines
        .map(
          (line, index) =>
            `<tspan x="${node.width / 2}" y="${text.valueStartY + index * text.valueLineHeight}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      return `<g class="draw-node" transform="translate(${nx}, ${ny})">
        ${shapeMarkup}
        <text x="${node.width / 2}" y="${text.labelStartY}" text-anchor="middle" font-size="${text.labelSize}" font-weight="600" fill="${node.text_hex}">${labelMarkup}</text>
        ${
          boundValueText
            ? `<text x="${node.width / 2}" y="${text.valueStartY}" text-anchor="middle" font-size="${text.valueSize}" font-weight="700" fill="${node.stroke_hex}">${valueMarkup}</text>`
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
