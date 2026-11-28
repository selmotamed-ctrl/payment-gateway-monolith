/**
 * Reader for `core-back/prisma/schema.prisma`.
 *
 * The Rust workspace cannot use `@prisma/internals` (the TS dependency is not installed in this
 * workspace), so this module parses the schema text directly. It is deliberately small and strict:
 * it understands exactly the constructs used by the payment-gateway schema and fails loudly on
 * anything else, so a schema change can never silently produce incomplete generated code.
 *
 * Output is ordered by the schema: enums and models keep their declaration order, fields keep
 * their column order. Nothing is sorted and nothing reads the clock.
 */

export type IdKind = "UuidV7" | "UuidV4" | "Cuid" | "None";

export interface EnumValueDef {
  /** The Prisma enum value (`ACTIVE`). */
  prisma: string;
  /** The PostgreSQL enum label (`@map`, or the Prisma value). */
  db: string;
  /** The Rust variant (`Active`). */
  variant: string;
}

export interface EnumDef {
  name: string;
  /** PostgreSQL enum type name (`@@map`, or the Prisma enum name). */
  dbName: string;
  values: EnumValueDef[];
}

export interface FieldDef {
  /** Prisma field name (the JSON name). */
  name: string;
  /** Rust field identifier, `r#type` for a keyword. */
  rustName: string;
  /** PostgreSQL column name (`@map`, or the field name). */
  column: string;
  /** Prisma scalar or enum type name. */
  typeName: string;
  /** `Uuid`, `Timestamptz`, `Decimal`, ... from `@db.*`, or null. */
  nativeType: string | null;
  /** Fully resolved Rust type (`Option<chrono::DateTime<chrono::Utc>>`, `Vec<enums::X>`, ...). */
  rustType: string;
  isList: boolean;
  isNullable: boolean;
  isEnum: boolean;
  /** `serde(rename)` value when `camelCase(field)` is not the Prisma name. */
  serdeRename: string | null;
  /** `sqlx(rename)` value when the column is not the Prisma field name. */
  sqlxRename: string | null;
}

export interface ModelDef {
  name: string;
  /** Physical table name (`@@map`, or the model name). */
  table: string;
  /** Scalar and enum fields only; relation fields are skipped. */
  fields: FieldDef[];
  /** `@id` column, or the generated member of a composite `@@id`. */
  idColumn: string;
  idKind: IdKind;
  updatedAtColumn: string | null;
  jsonNullableColumns: string[];
  defaultNowColumns: string[];
  /** The raw `@@id([...])` member names, when the model has a composite primary key. */
  compositeId: string[] | null;
}

export interface SchemaDef {
  schemaVersion: number;
  enums: EnumDef[];
  models: ModelDef[];
  /** Number of generated scalar/enum fields across all models. */
  fieldCount: number;
}

/* ------------------------------------------------------------------------------------------------
 * Raw (still textual) schema shapes
 * ---------------------------------------------------------------------------------------------- */

interface RawBlock {
  kind: "enum" | "model";
  name: string;
  body: string;
}

interface RawEnumValue {
  prisma: string;
  db: string;
}

interface RawEnum {
  name: string;
  dbName: string;
  values: RawEnumValue[];
}

interface RawField {
  name: string;
  typeName: string;
  isList: boolean;
  isOptional: boolean;
  column: string;
  isId: boolean;
  isUpdatedAt: boolean;
  /** Whitespace-normalised `@default(...)` argument, or null. */
  defaultValue: string | null;
  /** `Uuid`, `Timestamptz`, `Decimal`, ... from `@db.*`, or null. */
  nativeType: string | null;
}

interface RawModel {
  name: string;
  table: string;
  fields: RawField[];
  compositeId: string[] | null;
}

interface Attribute {
  name: string;
  args: string | null;
}

/* ------------------------------------------------------------------------------------------------
 * Public entry point
 * ---------------------------------------------------------------------------------------------- */

export function parsePrismaSchema(source: string, schemaVersion: number): SchemaDef {
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error(`invalid schema version: ${String(schemaVersion)}`);
  }

  const cleanSource = stripComments(source.replace(/^\uFEFF/, ""));
  const blocks = findBlocks(cleanSource);
  const rawEnums: RawEnum[] = [];
  const rawModels: RawModel[] = [];

  for (const block of blocks) {
    if (block.kind === "enum") {
      rawEnums.push(parseEnumBlock(block.name, block.body));
    } else {
      rawModels.push(parseModelBlock(block.name, block.body));
    }
  }

  if (rawEnums.length === 0) {
    throw new Error("schema.prisma declares no enums");
  }
  if (rawModels.length === 0) {
    throw new Error("schema.prisma declares no models");
  }

  assertUniqueNames(rawEnums.map((entry) => entry.name), "enum");
  assertUniqueNames(rawModels.map((entry) => entry.name), "model");

  const enumNames = new Set(rawEnums.map((entry) => entry.name));
  const modelNames = new Set(rawModels.map((entry) => entry.name));
  for (const name of enumNames) {
    if (modelNames.has(name)) {
      throw new Error(`Prisma type name "${name}" is declared as both an enum and a model`);
    }
  }

  const enums = rawEnums.map(resolveEnum);
  const models = rawModels.map((model) => resolveModel(model, modelNames, enumNames));
  const fieldCount = models.reduce((total, model) => total + model.fields.length, 0);

  return { schemaVersion, enums, models, fieldCount };
}

/* ------------------------------------------------------------------------------------------------
 * Text scanning
 * ---------------------------------------------------------------------------------------------- */

/**
 * Replace Prisma comments with spaces, preserving newlines and string literals.
 *
 * `///` doc comments and `//` comments are line comments; a block comment is `/* ... *\/`.
 * `@default("{}")` and `@default("[]")` must survive untouched.
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "double" | "single" = "code";
  let escaped = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out.push("  ");
        index += 2;
        continue;
      }
      if (char === '"' || char === "'") {
        state = char === '"' ? "double" : "single";
        out.push(char);
        index += 1;
        continue;
      }
      out.push(char);
      index += 1;
      continue;
    }

    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      index += 1;
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        out.push("  ");
        index += 2;
        continue;
      }
      out.push(char === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }

    // Inside a string literal: copy verbatim, honour backslash escapes.
    out.push(char);
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if ((state === "double" && char === '"') || (state === "single" && char === "'")) {
      state = "code";
    }
    index += 1;
  }

  return out.join("");
}

function findBlocks(source: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const pattern = /^[ \t]*(enum|model|view|type)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const kind = match[1]!;
    const name = match[2]!;
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(source, open);

    if (kind === "view" || kind === "type") {
      throw new Error(
        `unsupported Prisma block "${kind} ${name}" (only enum and model blocks are supported)`,
      );
    }

    blocks.push({ kind: kind as "enum" | "model", name, body: source.slice(open + 1, close) });
    pattern.lastIndex = close + 1;
  }

  return blocks;
}

function findMatchingBrace(text: string, openIndex: number): number {
  if (text[openIndex] !== "{") {
    throw new Error("internal codegen error: findMatchingBrace did not start on '{'");
  }
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(`unterminated Prisma block starting at offset ${openIndex}`);
}

/** Split a block body into field/attribute statements, ignoring newlines inside (...) and [...]. */
function splitStatements(body: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (const char of body) {
    if (inString !== null) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        throw new Error("malformed Prisma block: unbalanced closing bracket");
      }
    }
    if (char === "\n" && depth === 0) {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  if (inString !== null) {
    throw new Error("malformed Prisma block: unterminated string literal");
  }
  if (depth !== 0) {
    throw new Error("malformed Prisma block: unbalanced bracket");
  }

  return statements;
}

/** Return every `@name` / `@name(...)` attribute in a field or value statement. */
function scanAttributes(text: string): Attribute[] {
  const attributes: Attribute[] = [];
  let index = 0;
  let inString: string | null = null;
  let escaped = false;

  while (index < text.length) {
    const char = text[index]!;
    if (inString !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      index += 1;
      continue;
    }
    if (char !== "@") {
      index += 1;
      continue;
    }
    if (text[index + 1] === "@") {
      // Block attribute (only valid on its own statement; not a field attribute).
      index += 2;
      continue;
    }

    let end = index + 1;
    while (end < text.length && /[A-Za-z0-9_.]/.test(text[end]!)) {
      end += 1;
    }
    if (end === index + 1) {
      index += 1;
      continue;
    }

    const name = text.slice(index + 1, end);
    if (text[end] === "(") {
      const close = findMatchingParen(text, end);
      attributes.push({ name, args: text.slice(end + 1, close) });
      index = close + 1;
    } else {
      attributes.push({ name, args: null });
      index = end;
    }
  }

  return attributes;
}

function findMatchingParen(text: string, openIndex: number): number {
  if (text[openIndex] !== "(") {
    throw new Error("internal codegen error: findMatchingParen did not start on '('");
  }
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error("unterminated attribute argument list");
}

/**
 * Parse a `@@name(...)` block attribute.
 *
 * Returns `undefined` when the statement is a different block attribute, `null` when it is this
 * attribute without arguments, and the raw argument text otherwise.
 */
function parseBlockAttribute(statement: string, name: string): string | null | undefined {
  const prefix = `@@${name}`;
  if (!statement.startsWith(prefix)) {
    return undefined;
  }
  const after = statement[prefix.length] ?? "";
  if (after === "(") {
    const close = findMatchingParen(statement, prefix.length);
    return statement.slice(prefix.length + 1, close);
  }
  if (after === "" || /\s/.test(after)) {
    return null;
  }
  return undefined;
}

/** The first double-quoted string literal in an attribute argument list, unescaped. */
function parseStringArgument(args: string | null, context: string): string {
  if (args === null) {
    throw new Error(`${context}: expected a string argument`);
  }
  const match = /"((?:[^"\\]|\\.)*)"/.exec(args);
  if (!match) {
    throw new Error(`${context}: expected a double-quoted string argument`);
  }
  try {
    return JSON.parse(`"${match[1]!}"`) as string;
  } catch {
    throw new Error(`${context}: invalid string escape in ${JSON.stringify(args)}`);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Enum parsing
 * ---------------------------------------------------------------------------------------------- */

function parseEnumBlock(name: string, body: string): RawEnum {
  let dbName = name;
  const values: RawEnumValue[] = [];

  for (const statement of splitStatements(body)) {
    if (statement.startsWith("@@")) {
      const mapArgs = parseBlockAttribute(statement, "map");
      if (mapArgs === undefined) {
        throw new Error(`enum ${name}: unsupported block attribute "${statement}"`);
      }
      dbName = parseStringArgument(mapArgs, `enum ${name} @@map`);
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*)$/.exec(statement);
    if (!match) {
      throw new Error(`enum ${name}: cannot parse value statement "${truncate(statement)}"`);
    }
    const prisma = match[1]!;
    const attributes = scanAttributes(match[2] ?? "");
    let db = prisma;
    let mapCount = 0;

    for (const attribute of attributes) {
      if (attribute.name !== "map") {
        throw new Error(`enum ${name}: unsupported attribute @${attribute.name} on ${prisma}`);
      }
      mapCount += 1;
      if (mapCount > 1) {
        throw new Error(`enum ${name}: value ${prisma} has more than one @map`);
      }
      db = parseStringArgument(attribute.args, `enum ${name} value ${prisma} @map`);
    }

    values.push({ prisma, db });
  }

  if (values.length === 0) {
    throw new Error(`enum ${name}: no values`);
  }
  if (dbName.length === 0) {
    throw new Error(`enum ${name}: empty database type name`);
  }

  return { name, dbName, values };
}

function resolveEnum(raw: RawEnum): EnumDef {
  assertPascalCase(raw.name, `enum ${raw.name}`);
  const seenVariants = new Map<string, string>();
  const seenDbValues = new Set<string>();
  const values: EnumValueDef[] = [];

  for (const value of raw.values) {
    assertIdentifier(value.prisma, `enum ${raw.name} value`);
    if (value.db.length === 0) {
      throw new Error(`enum ${raw.name}: value ${value.prisma} has an empty @map`);
    }

    const variant = upperCamel(value.prisma);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(variant)) {
      throw new Error(
        `enum ${raw.name}: value ${value.prisma} cannot become a Rust variant (got "${variant}")`,
      );
    }
    if (variant === "Self") {
      throw new Error(`enum ${raw.name}: value ${value.prisma} maps to the reserved variant Self`);
    }

    const previous = seenVariants.get(variant);
    if (previous !== undefined) {
      throw new Error(
        `enum ${raw.name}: values ${previous} and ${value.prisma} both map to Rust variant ${variant}`,
      );
    }
    if (seenDbValues.has(value.db)) {
      throw new Error(
        `enum ${raw.name}: duplicate database value "${value.db}" (from ${value.prisma})`,
      );
    }

    seenVariants.set(variant, value.prisma);
    seenDbValues.add(value.db);
    values.push({ prisma: value.prisma, db: value.db, variant });
  }

  return { name: raw.name, dbName: raw.dbName, values };
}

/* ------------------------------------------------------------------------------------------------
 * Model parsing
 * ---------------------------------------------------------------------------------------------- */

function parseModelBlock(name: string, body: string): RawModel {
  let table = name;
  let compositeId: string[] | null = null;
  const fields: RawField[] = [];

  for (const statement of splitStatements(body)) {
    if (statement.startsWith("@@")) {
      const mapArgs = parseBlockAttribute(statement, "map");
      if (mapArgs !== undefined) {
        table = parseStringArgument(mapArgs, `model ${name} @@map`);
        continue;
      }
      const idArgs = parseBlockAttribute(statement, "id");
      if (idArgs !== undefined) {
        compositeId = parseCompositeId(idArgs, name);
        continue;
      }
      // @@index, @@unique, @@schema, ... do not affect row structs or the metadata table.
      continue;
    }

    fields.push(parseField(name, statement));
  }

  if (fields.length === 0) {
    throw new Error(`model ${name}: no fields`);
  }
  if (table.length === 0) {
    throw new Error(`model ${name}: empty database table name`);
  }

  return { name, table, fields, compositeId };
}

function parseCompositeId(args: string | null, modelName: string): string[] {
  if (args === null) {
    throw new Error(`model ${modelName} @@id: expected a field list`);
  }
  const bracket = /\[([\s\S]*?)\]/.exec(args);
  if (!bracket) {
    throw new Error(`model ${modelName} @@id: expected [field, ...]`);
  }
  const fields = bracket[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(entry);
      if (!name) {
        throw new Error(`model ${modelName} @@id: cannot parse field entry "${entry}"`);
      }
      return name[0]!;
    });

  if (fields.length === 0) {
    throw new Error(`model ${modelName} @@id: empty field list`);
  }
  return fields;
}

function parseField(modelName: string, statement: string): RawField {
  const match =
    /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?(?:\s+([\s\S]*))?$/.exec(
      statement,
    );
  if (!match) {
    throw new Error(`model ${modelName}: cannot parse field "${truncate(statement)}"`);
  }

  const name = match[1]!;
  const typeName = match[2]!;
  const isList = match[3] !== undefined;
  const isOptional = match[4] !== undefined;
  if (isList && isOptional) {
    throw new Error(`model ${modelName}: field ${name} cannot be both a list and optional`);
  }

  const attributes = scanAttributes(match[5] ?? "");
  const maps = attributes.filter((attribute) => attribute.name === "map");
  const defaults = attributes.filter((attribute) => attribute.name === "default");
  const natives = attributes.filter((attribute) => attribute.name.startsWith("db."));

  if (maps.length > 1) {
    throw new Error(`model ${modelName}: field ${name} has more than one @map`);
  }
  if (defaults.length > 1) {
    throw new Error(`model ${modelName}: field ${name} has more than one @default`);
  }
  if (natives.length > 1) {
    throw new Error(`model ${modelName}: field ${name} has more than one native type`);
  }

  const column =
    maps.length === 1
      ? parseStringArgument(maps[0]!.args, `model ${modelName} field ${name} @map`)
      : name;
  if (column.length === 0) {
    throw new Error(`model ${modelName}: field ${name} has an empty @map`);
  }

  let defaultValue: string | null = null;
  if (defaults.length === 1) {
    const args = defaults[0]!.args;
    if (args === null) {
      throw new Error(`model ${modelName}: field ${name} @default has no arguments`);
    }
    defaultValue = args.replace(/\s+/g, "");
  }

  const nativeType = natives.length === 1 ? natives[0]!.name.slice("db.".length) : null;

  return {
    name,
    typeName,
    isList,
    isOptional,
    column,
    isId: attributes.some((attribute) => attribute.name === "id"),
    isUpdatedAt: attributes.some((attribute) => attribute.name === "updatedAt"),
    defaultValue,
    nativeType,
  };
}

function resolveModel(
  raw: RawModel,
  modelNames: ReadonlySet<string>,
  enumNames: ReadonlySet<string>,
): ModelDef {
  assertPascalCase(raw.name, `model ${raw.name}`);

  const scalarFields = raw.fields.filter((field) => !modelNames.has(field.typeName));
  if (scalarFields.length === 0) {
    throw new Error(`model ${raw.name}: no scalar fields (only relation fields)`);
  }

  const seenFields = new Set<string>();
  const seenColumns = new Set<string>();
  const fields: FieldDef[] = [];

  for (const field of scalarFields) {
    if (seenFields.has(field.name)) {
      throw new Error(`model ${raw.name}: duplicate field ${field.name}`);
    }
    if (seenColumns.has(field.column)) {
      throw new Error(
        `model ${raw.name}: field ${field.name} reuses column "${field.column}"`,
      );
    }
    seenFields.add(field.name);
    seenColumns.add(field.column);
    fields.push(resolveField(raw.name, field, enumNames));
  }

  const id = resolveId(raw);
  const updatedAtFields = scalarFields.filter((field) => field.isUpdatedAt);
  if (updatedAtFields.length > 1) {
    throw new Error(`model ${raw.name}: more than one @updatedAt field`);
  }

  return {
    name: raw.name,
    table: raw.table,
    fields,
    idColumn: id.column,
    idKind: id.kind,
    updatedAtColumn: updatedAtFields.length === 1 ? updatedAtFields[0]!.column : null,
    jsonNullableColumns: scalarFields
      .filter(
        (field) =>
          field.typeName === "Json" && !enumNames.has(field.typeName) && field.isOptional,
      )
      .map((field) => field.column),
    defaultNowColumns: scalarFields
      .filter((field) => field.defaultValue === "now()")
      .map((field) => field.column),
    compositeId: raw.compositeId,
  };
}

function resolveField(
  modelName: string,
  raw: RawField,
  enumNames: ReadonlySet<string>,
): FieldDef {
  const isEnum = enumNames.has(raw.typeName);
  const rustBase = baseRustType(modelName, raw, isEnum);

  let rustType = rustBase;
  if (raw.isList) {
    rustType = `Vec<${rustType}>`;
  }
  if (raw.isOptional) {
    rustType = `Option<${rustType}>`;
  }

  const isRawIdentifier = RUST_KEYWORDS.has(raw.name);
  if (isRawIdentifier && !RAW_IDENTIFIER_KEYWORDS.has(raw.name)) {
    throw new Error(
      `model ${modelName}: field ${raw.name} is a Rust keyword that cannot be a raw identifier`,
    );
  }

  const camelName = lowerCamel(raw.name);
  const serdeRename = camelName !== raw.name || isRawIdentifier ? raw.name : null;

  return {
    name: raw.name,
    rustName: isRawIdentifier ? `r#${raw.name}` : raw.name,
    column: raw.column,
    typeName: raw.typeName,
    nativeType: raw.nativeType,
    rustType,
    isList: raw.isList,
    isNullable: raw.isOptional,
    isEnum,
    serdeRename,
    sqlxRename: raw.column !== raw.name ? raw.column : null,
  };
}

function baseRustType(modelName: string, raw: RawField, isEnum: boolean): string {
  const native = raw.nativeType;

  if (isEnum) {
    if (native !== null) {
      throw new Error(
        `model ${modelName}: enum field ${raw.name} cannot use native type @db.${native}`,
      );
    }
    return `enums::${raw.typeName}`;
  }

  switch (raw.typeName) {
    case "String":
      if (native === null || native === "VarChar" || native === "Char" || native === "Text") {
        return "String";
      }
      if (native === "Uuid") {
        return "uuid::Uuid";
      }
      throw nativeTypeError(modelName, raw, "String, Uuid, VarChar, Char or Text");

    case "Int":
      if (native === null || native === "SmallInt" || native === "Integer") {
        return "i32";
      }
      throw nativeTypeError(modelName, raw, "SmallInt or Integer");

    case "BigInt":
      if (native === null || native === "BigInt") {
        return "i64";
      }
      throw nativeTypeError(modelName, raw, "BigInt");

    case "Float":
      if (MONEY_FIELD.test(raw.name)) {
        throw new Error(
          `model ${modelName}: Float field ${raw.name} looks like money; use Decimal`,
        );
      }
      if (native === null || native === "DoublePrecision" || native === "Real") {
        return "f64";
      }
      throw nativeTypeError(modelName, raw, "DoublePrecision or Real");

    case "Decimal":
      if (native === null || native === "Decimal") {
        return "rust_decimal::Decimal";
      }
      throw nativeTypeError(modelName, raw, "Decimal");

    case "Boolean":
      if (native === null || native === "Boolean") {
        return "bool";
      }
      throw nativeTypeError(modelName, raw, "Boolean");

    case "DateTime":
      if (native === "Date") {
        return "chrono::NaiveDate";
      }
      if (native === "Time") {
        return "chrono::NaiveTime";
      }
      if (native === "Timestamptz") {
        return "chrono::DateTime<chrono::Utc>";
      }
      if (native === null || native === "Timestamp") {
        return "chrono::NaiveDateTime";
      }
      throw nativeTypeError(modelName, raw, "Date, Time, Timestamp or Timestamptz");

    case "Json":
      if (native === null || native === "Json" || native === "JsonB") {
        return "serde_json::Value";
      }
      throw nativeTypeError(modelName, raw, "Json or JsonB");

    case "Bytes":
      if (native === null || native === "ByteA") {
        return "Vec<u8>";
      }
      throw nativeTypeError(modelName, raw, "ByteA");

    default:
      throw new Error(
        `model ${modelName}: field ${raw.name} has unsupported type "${raw.typeName}"` +
          (native === null ? "" : ` (@db.${native})`),
      );
  }
}

function nativeTypeError(modelName: string, raw: RawField, expected: string): Error {
  return new Error(
    `model ${modelName}: field ${raw.name} has type ${raw.typeName} with unsupported native type ` +
      `@db.${raw.nativeType}; expected ${expected}`,
  );
}

function resolveId(raw: RawModel): { column: string; kind: IdKind } {
  const idFields = raw.fields.filter((field) => field.isId);
  if (idFields.length > 1) {
    throw new Error(`model ${raw.name}: more than one @id field`);
  }
  if (idFields.length === 1) {
    const field = idFields[0]!;
    return {
      column: field.column,
      kind: idKindFromDefault(raw.name, field),
    };
  }

  if (raw.compositeId !== null && raw.compositeId.length > 0) {
    const members = raw.compositeId.map((name) => {
      const field = raw.fields.find((candidate) => candidate.name === name);
      if (field === undefined) {
        throw new Error(`model ${raw.name} @@id: unknown field ${name}`);
      }
      return field;
    });

    const generated = members.filter((field) => idKindFromDefault(raw.name, field) !== "None");
    if (generated.length > 1) {
      throw new Error(
        `model ${raw.name}: composite primary key has more than one generated id member`,
      );
    }
    if (generated.length === 1) {
      const field = generated[0]!;
      return { column: field.column, kind: idKindFromDefault(raw.name, field) };
    }

    return { column: members.map((field) => field.column).join(","), kind: "None" };
  }

  throw new Error(`model ${raw.name}: no @id and no @@id`);
}

function idKindFromDefault(modelName: string, field: RawField): IdKind {
  const value = field.defaultValue;
  if (value === null) {
    return "None";
  }
  if (value === "cuid()") {
    return "Cuid";
  }

  const uuid = /^uuid\((\d*)\)$/.exec(value);
  if (uuid) {
    const version = uuid[1] === "" ? "4" : uuid[1]!;
    if (version === "7") {
      return "UuidV7";
    }
    if (version === "4") {
      return "UuidV4";
    }
    throw new Error(
      `model ${modelName}: id field ${field.name} uses unsupported @default(uuid(${version}))`,
    );
  }

  if (/^(?:cuid|nanoid|ulid)\(/.test(value)) {
    throw new Error(
      `model ${modelName}: id field ${field.name} uses unsupported @default(${value})`,
    );
  }

  // `now()`, `autoincrement()` and `dbgenerated(...)` are not client-side id generators.
  return "None";
}

/* ------------------------------------------------------------------------------------------------
 * Name helpers
 * ---------------------------------------------------------------------------------------------- */

const RUST_KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "try",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
]);

/** Keywords that Rust accepts only as `r#name`; `self`, `Self`, `super` and `crate` are invalid. */
const RAW_IDENTIFIER_KEYWORDS = new Set(
  [...RUST_KEYWORDS].filter(
    (keyword) => keyword !== "self" && keyword !== "Self" && keyword !== "super" && keyword !== "crate",
  ),
);

const MONEY_FIELD = /(amount|balance|fee|commission|volume|total|net|price|rate)/i;

function upperCamel(value: string): string {
  const parts = value.split("_").filter((part) => part.length > 0);
  return parts
    .map((part) => {
      if (/^[A-Z0-9]+$/.test(part)) {
        return part.charAt(0) + part.slice(1).toLowerCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}

function lowerCamel(value: string): string {
  if (!value.includes("_")) {
    return value.charAt(0).toLowerCase() + value.slice(1);
  }
  const parts = value.split("_").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return value;
  }
  const first = parts[0]!;
  return (
    first.charAt(0).toLowerCase() +
    first.slice(1) +
    parts
      .slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")
  );
}

function assertIdentifier(name: string, context: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${context}: "${name}" is not a valid Prisma identifier`);
  }
}

function assertPascalCase(name: string, context: string): void {
  assertIdentifier(name, context);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw new Error(`${context}: "${name}" is not PascalCase; the Rust generator requires it`);
  }
}

function assertUniqueNames(names: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    assertIdentifier(name, `${kind} name`);
    if (seen.has(name)) {
      throw new Error(`duplicate ${kind} name "${name}" in schema.prisma`);
    }
    seen.add(name);
  }
}

function truncate(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}
