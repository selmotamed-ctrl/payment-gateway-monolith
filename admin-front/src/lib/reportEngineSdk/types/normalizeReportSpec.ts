type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord | null => (isRecord(value) ? value : null);

/**
 * Accepts the small set of authoring aliases that external AIs commonly emit.
 * The canonical persisted form remains ReportDescriptorSpec v1.0; aliases are
 * normalised before Zod validation so a valid intent is not rejected for a
 * naming difference.
 */
export function normalizeReportSpec(input: unknown): unknown {
  const source = asRecord(input);
  if (!source) return input;
  let clone: UnknownRecord;
  try {
    clone = structuredClone(source) as UnknownRecord;
  } catch {
    clone = { ...source };
  }

  if (Array.isArray(clone.inputs)) {
    clone.inputs = clone.inputs.map((item) => {
      const field = asRecord(item);
      if (!field) return item;
      const copy = { ...field };
      const defaultValue = asRecord(copy.default_value);
      if (defaultValue && "literal" in defaultValue) {
        copy.default_value = defaultValue.literal;
      }
      return copy;
    });
  }

  if (Array.isArray(clone.transforms)) {
    clone.transforms = clone.transforms.map((item) => {
      const transform = asRecord(item);
      if (!transform) return item;
      const copy = { ...transform };
      if (!copy.operation && typeof copy.kind === "string") {
        copy.operation = copy.kind;
      }
      if (typeof copy.operation === "string") {
        copy.operation = copy.operation.toUpperCase();
      }
      if (copy.operation === "COMPUTE_COLUMN") {
        const formula = copy.formula ?? copy.compute ?? copy.compute_op ?? copy.operator;
        if (formula !== undefined) copy.formula = String(formula).toUpperCase();
      }
      delete copy.kind;
      delete copy.compute;
      delete copy.compute_op;
      delete copy.operator;
      return copy;
    });
  }

  if (Array.isArray(clone.sections)) {
    clone.sections = clone.sections.map((item) => {
      const section = asRecord(item);
      if (!section) return item;
      const copy = { ...section };
      if (copy.section_type === "VECTOR_DRAW" && typeof copy.view_box === "string") {
        const parts = copy.view_box.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && parts.every((part) => Number.isFinite(part))) {
          copy.view_box = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } else if (parts.length === 2 && parts.every((part) => Number.isFinite(part))) {
          copy.view_box = { width: parts[0], height: parts[1] };
        }
      }
      return copy;
    });
  }

  return clone;
}
