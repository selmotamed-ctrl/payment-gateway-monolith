import type { ReportEngineHostConfig } from "../types/hostConfig";
import type { ReportDescriptorSpec } from "../types/reportSpec";
import type { ReportDiagnostic } from "../types/diagnostics";
import { validateSafeHtmlAndScopedCss } from "./CssAndHtmlSanitizer";

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

  const transformOutputs = new Set<string>();
  for (let i = 0; i < spec.transforms.length; i++) {
    const transform = spec.transforms[i]!;
    const sourceIds = "source_dataset_id" in transform
      ? [transform.source_dataset_id]
      : "left_dataset_id" in transform
        ? [transform.left_dataset_id, transform.right_dataset_id]
        : [transform.target_dataset_id];
    for (const source of sourceIds) {
      if (!datasetIds.has(source) && !transformOutputs.has(source)) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: `transforms[${i}]`,
          code: "UNKNOWN_TRANSFORM_DATASET",
          message: `Transform references unknown dataset "${source}".`,
          aiFixHint: "Reference a dataset declared in datasets[] or an earlier transform output.",
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
    if ("output_dataset_id" in transform) transformOutputs.add(transform.output_dataset_id);
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
    if (section.visibility?.dataset_id && !datasetIds.has(section.visibility.dataset_id)) {
      diagnostics.push({
        layer: 1,
        severity: "error",
        path: `${path}.visibility.dataset_id`,
        code: "UNKNOWN_VISIBILITY_DATASET",
        message: `Visibility references unknown dataset "${section.visibility.dataset_id}".`,
        aiFixHint: "Use a declared dataset_id.",
      });
    }
    const checkField = (dataset: string, field: string, fieldPath: string) => {
      if (!datasetIds.has(dataset)) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: fieldPath,
          code: "UNKNOWN_SECTION_DATASET",
          message: `Section references unknown dataset "${dataset}".`,
          aiFixHint: "Use a declared dataset_id.",
        });
        return;
      }
      const ds = spec.datasets.find((candidate) => candidate.dataset_id === dataset);
      if (ds && !ds.select.some((select) => select.alias === field || (select.column === "*" && field === select.alias))) {
        diagnostics.push({
          layer: 1,
          severity: "error",
          path: fieldPath,
          code: "UNKNOWN_SECTION_FIELD",
          message: `Section field "${field}" is not selected by dataset "${dataset}".`,
          aiFixHint: "Use a select alias from the dataset.",
        });
      }
    };
    if (section.section_type === "KPI_GRID") {
      section.cards.forEach((card, cardIndex) =>
        checkField(card.dataset_id, card.value_field, `${path}.cards[${cardIndex}].value_field`),
      );
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
