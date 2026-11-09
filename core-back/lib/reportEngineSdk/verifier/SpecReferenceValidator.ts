import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";

const levenshtein = (left: string, right: string): number => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length]!;
};

const closestMatch = (value: string, candidates: Iterable<string>): string | null => {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === "*" || candidate === value) continue;
    const distance = levenshtein(value, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= Math.max(2, Math.floor(value.length / 3)) ? best : null;
};

const formatAvailable = (values: Iterable<string>, limit = 30): string => {
  const list = [...values].filter((value) => value !== "*").sort();
  if (list.length === 0) return "(none)";
  return list.length > limit ? `${list.slice(0, limit).join(", ")} … (${list.length} total)` : list.join(", ");
};

export function validateSpecReferences(
  spec: ReportDescriptorSpec,
  host: ReportEngineHostConfig,
): ReportDiagnostic[] {
  const diagnostics: ReportDiagnostic[] = [];
  const datasetIds = new Set<string>();
  for (let i = 0; i < spec.datasets.length; i++) {
    const ds = spec.datasets[i]!;
    if (datasetIds.has(ds.dataset_id)) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `datasets[${i}].dataset_id`,
        code: "DUPLICATE_DATASET_ID",
        message: `Dataset id "${ds.dataset_id}" is used more than once.`,
        aiFixHint: "Give every dataset a unique dataset_id.",
      });
    }
    datasetIds.add(ds.dataset_id);
  }

  const assetKeys = new Set<string>();
  for (let i = 0; i < spec.required_assets.length; i++) {
    const asset = spec.required_assets[i]!;
    if (assetKeys.has(asset.asset_key)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `required_assets[${i}].asset_key`,
        code: "DUPLICATE_ASSET_KEY",
        message: `Asset key "${asset.asset_key}" is declared more than once.`,
        aiFixHint: "Give every required asset a unique asset_key.",
      });
    }
    assetKeys.add(asset.asset_key);
    if (asset.purpose === "COMPARISON_BASELINE_DATA" && !["application/json", "text/csv"].includes(asset.mime_type)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `required_assets[${i}]`,
        code: "COMPARISON_ASSET_MIME_INVALID",
        message: "A comparison baseline must be application/json or text/csv.",
        aiFixHint: "Use a JSON or CSV comparison asset.",
      });
    }
    if (asset.purpose === "VISUAL_IMAGE" && !asset.mime_type.startsWith("image/")) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `required_assets[${i}]`,
        code: "VISUAL_ASSET_MIME_INVALID",
        message: "A visual asset must be an image MIME type.",
        aiFixHint: "Use image/png, image/jpeg, image/webp or image/svg+xml.",
      });
    }
  }

  const inputKeys = new Set(spec.inputs.map((input) => input.key));
  for (let i = 0; i < spec.inputs.length; i++) {
    const input = spec.inputs[i]!;
    if (input.autocomplete?.depends_on_input && !inputKeys.has(input.autocomplete.depends_on_input)) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `inputs[${i}].autocomplete.depends_on_input`,
        code: "UNKNOWN_INPUT_DEPENDENCY",
        message: `Autocomplete dependency "${input.autocomplete.depends_on_input}" is not a declared input.`,
        aiFixHint: "Point depends_on_input at a declared input key.",
      });
    }
    if (input.autocomplete && !host.autocompleteProviders[input.autocomplete.source]) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `inputs[${i}].autocomplete.source`,
        code: "UNKNOWN_AUTOCOMPLETE_SOURCE",
        message: `Autocomplete source "${input.autocomplete.source}" is not registered by the host.`,
        aiFixHint: "Use one of the transcript autocomplete sources.",
      });
    }
  }

  // Layer 1 field registry: select aliases, window aliases and transform outputs.
  const datasetFields = new Map<string, Set<string>>();
  for (const ds of spec.datasets) {
    const fields = new Set<string>(ds.select.map((select) => select.alias));
    for (const window of ds.window_fields) fields.add(window.alias);
    datasetFields.set(ds.dataset_id, fields);
  }

  for (let i = 0; i < spec.transforms.length; i++) {
    const transform = spec.transforms[i]!;
    const sourceIds = "source_dataset_id" in transform
      ? [transform.source_dataset_id]
      : "left_dataset_id" in transform
        ? [transform.left_dataset_id, transform.right_dataset_id]
        : [transform.target_dataset_id];
    for (const source of sourceIds) {
      if (!datasetFields.has(source)) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `transforms[${i}]`,
          code: "UNKNOWN_TRANSFORM_DATASET",
          message: `Transform references unknown dataset "${source}". Available datasets and transform outputs: ${formatAvailable(datasetFields.keys())}.`,
          aiFixHint: `Reference a dataset declared in datasets[] or an earlier transform output.${closestMatch(source, datasetFields.keys()) ? ` Did you mean "${closestMatch(source, datasetFields.keys())}"?` : ""}`,
        });
      }
    }
    if (transform.operation === "COMPARE_WITH_ASSET" && !assetKeys.has(transform.asset_key)) {
      diagnostics.push({
        layer: 4,
        severity: "error",
        path: `transforms[${i}].asset_key`,
        code: "UNKNOWN_COMPARISON_ASSET",
        message: `COMPARE_WITH_ASSET references asset "${transform.asset_key}", which is not declared in required_assets.`,
        aiFixHint: "Declare the comparison asset in required_assets[].",
      });
    }

    switch (transform.operation) {
      case "COMPUTE_COLUMN": {
        const fields = datasetFields.get(transform.target_dataset_id) ?? new Set<string>();
        fields.add(transform.output_column);
        datasetFields.set(transform.target_dataset_id, fields);
        break;
      }
      case "JOIN_DATASETS": {
        const fields = new Set<string>([
          ...(datasetFields.get(transform.left_dataset_id) ?? []),
          ...(datasetFields.get(transform.right_dataset_id) ?? []),
        ]);
        datasetFields.set(transform.output_dataset_id, fields);
        break;
      }
      case "PIVOT_DATASET": {
        // Pivot column names are data-dependent, so the output is a wildcard
        // registry; the row key is always addressable.
        datasetFields.set(transform.output_dataset_id, new Set([transform.row_key, "*"]));
        break;
      }
      case "COMPARE_WITH_ASSET": {
        const fields = new Set<string>(datasetFields.get(transform.source_dataset_id) ?? []);
        fields.add("_asset_matched");
        fields.add("_has_discrepancy");
        for (const compare of transform.compare_fields) {
          fields.add(compare.asset_field);
          if (compare.output_field) fields.add(compare.output_field);
          fields.add(`${compare.dataset_field}_expected`);
          fields.add(`${compare.dataset_field}_variance`);
        }
        datasetFields.set(transform.output_dataset_id, fields);
        break;
      }
    }
  }

  const sectionIds = new Set<string>();
  for (let i = 0; i < spec.sections.length; i++) {
    const section = spec.sections[i]!;
    const path = `sections[${i}](${section.section_id})`;
    if (sectionIds.has(section.section_id)) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `${path}.section_id`,
        code: "DUPLICATE_SECTION_ID",
        message: `Section id "${section.section_id}" is used more than once.`,
        aiFixHint: "Give every section a unique section_id.",
      });
    }
    sectionIds.add(section.section_id);
    if (section.visibility?.dataset_id && !datasetFields.has(section.visibility.dataset_id)) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `${path}.visibility.dataset_id`,
        code: "UNKNOWN_VISIBILITY_DATASET",
        message: `Visibility references unknown dataset "${section.visibility.dataset_id}". Available datasets and transform outputs: ${formatAvailable(datasetFields.keys())}.`,
        aiFixHint: `Use a declared dataset_id or a transform output dataset.${closestMatch(section.visibility.dataset_id, datasetFields.keys()) ? ` Did you mean "${closestMatch(section.visibility.dataset_id, datasetFields.keys())}"?` : ""}`,
      });
    }
    const checkField = (dataset: string, field: string, fieldPath: string) => {
      const fields = datasetFields.get(dataset);
      if (!fields) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: fieldPath,
          code: "UNKNOWN_SECTION_DATASET",
          message: `Section references unknown dataset "${dataset}". Available datasets and transform outputs: ${formatAvailable(datasetFields.keys())}.`,
          aiFixHint: `Use a declared dataset_id or a transform output dataset.${closestMatch(dataset, datasetFields.keys()) ? ` Did you mean "${closestMatch(dataset, datasetFields.keys())}"?` : ""}`,
        });
        return;
      }
      if (!fields.has(field) && !fields.has("*")) {
        const suggestion = closestMatch(field, fields);
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: fieldPath,
          code: "UNKNOWN_SECTION_FIELD",
          message: `Section field "${field}" is not selected or produced by dataset "${dataset}". Available fields: ${formatAvailable(fields)}.`,
          aiFixHint: `Use a select alias, window alias or transform output field from the dataset.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
        });
      }
    };
    if (section.section_type === "KPI_GRID") {
      section.cards.forEach((card, cardIndex) => {
        checkField(card.dataset_id, card.value_field, `${path}.cards[${cardIndex}].value_field`);
        if (card.delta_field) {
          checkField(card.dataset_id, card.delta_field, `${path}.cards[${cardIndex}].delta_field`);
        }
      });
    } else if (section.section_type === "DATA_TABLE") {
      section.columns.forEach((column, columnIndex) =>
        checkField(section.dataset_id, column.field, `${path}.columns[${columnIndex}].field`),
      );
    } else if (section.section_type === "CHART") {
      checkField(section.dataset_id, section.x_field, `${path}.x_field`);
      section.series.forEach((series, seriesIndex) =>
        checkField(section.dataset_id, series.field, `${path}.series[${seriesIndex}].field`),
      );
    } else if (section.section_type === "VECTOR_DRAW") {
      section.nodes.forEach((node, nodeIndex) => {
        if (node.value_binding) {
          checkField(
            node.value_binding.dataset_id,
            node.value_binding.field,
            `${path}.nodes[${nodeIndex}].value_binding.field`,
          );
        }
      });
      if (section.custom_svg_template) {
        diagnostics.push(
          ...validateSafeHtmlAndScopedCss({
            html: section.custom_svg_template,
            scopedCss: "",
            basePath: `${path}.custom_svg_template`,
          }),
        );
      }
    } else if (section.section_type === "IMAGE_BANNER") {
      if (!assetKeys.has(section.asset_key)) {
        diagnostics.push({
          layer: 4,
          severity: "error",
          path: `${path}.asset_key`,
          code: "UNKNOWN_IMAGE_ASSET",
          message: `Image banner references undeclared asset "${section.asset_key}".`,
          aiFixHint: "Declare the image in required_assets[].",
        });
      }
    }
  }

  const inlineHeader = spec.page_layout.inline_header_spec;
  if (inlineHeader) {
    diagnostics.push(
      ...validateSafeHtmlAndScopedCss({
        html: inlineHeader.html,
        scopedCss: inlineHeader.scoped_css ?? "",
        basePath: "page_layout.inline_header_spec",
      }),
    );
  }
  const inlineFooter = spec.page_layout.inline_footer_spec;
  if (inlineFooter) {
    diagnostics.push(
      ...validateSafeHtmlAndScopedCss({
        html: inlineFooter.html,
        scopedCss: inlineFooter.scoped_css ?? "",
        basePath: "page_layout.inline_footer_spec",
      }),
    );
  }
  if (spec.page_layout.global_scoped_css) {
    diagnostics.push(
      ...validateSafeHtmlAndScopedCss({
        html: "",
        scopedCss: spec.page_layout.global_scoped_css,
        basePath: "page_layout.global_scoped_css",
      }),
    );
  }

  for (const role of spec.suggested_access?.roles ?? []) {
    if (!host.rolesCatalog.includes(role)) {
      diagnostics.push({
        layer: 3,
        severity: "warning",
        path: "suggested_access.roles",
        code: "UNKNOWN_SUGGESTED_ROLE",
        message: `Suggested role "${role}" is not in the host roles catalogue.`,
        aiFixHint: "Use a role from the transcript.",
      });
    }
  }
  for (const authority of spec.suggested_access?.authorities ?? []) {
    if (!host.authoritiesCatalog.includes(authority)) {
      diagnostics.push({
        layer: 3,
        severity: "warning",
        path: "suggested_access.authorities",
        code: "UNKNOWN_SUGGESTED_AUTHORITY",
        message: `Suggested authority "${authority}" is not in the host authorities catalogue.`,
        aiFixHint: "Use an authority from the transcript.",
      });
    }
  }

  return diagnostics;
}
