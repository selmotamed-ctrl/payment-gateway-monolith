import { createHash, createHmac, randomInt as secureRandomInt, randomUUID } from "node:crypto";
import { CryptoEngine, type HashOutputEncoding, type KeyEncoding } from "../crypto/CryptoEngine";

export type TransformOperation =
  | "scale"
  | "MUL_INT"
  | "DIV_DECIMAL"
  | "round"
  | "format_decimal"
  | "to_int"
  | "to_number"
  | "to_string"
  | "concat"
  | "template"
  | "lowercase"
  | "uppercase"
  | "trim"
  | "pad_left"
  | "pad_right"
  | "substring"
  | "mask"
  | "prepend"
  | "arabic_digits_to_ascii"
  | "phone_normalize"
  | "sort_keys"
  | "values_only"
  | "join_pairs"
  | "format_date"
  | "epoch_seconds"
  | "epoch_millis"
  | "uuid"
  | "numeric_random"
  | "base64_encode"
  | "hex_lower"
  | "hex_upper"
  | "url_encode"
  | "json_encode"
  | "xml_escape"
  | "sha256"
  | "sha512"
  | "hmac_sha256"
  | "hmac_sha512"
  | "rsa_sha256_sign";

export interface TransformPipe {
  readonly op: TransformOperation;
  readonly args?: readonly unknown[];
}

export interface TransformSecretResolver {
  resolveSecret(reference: string): Promise<string | Buffer> | string | Buffer;
}

export interface TransformContext {
  secretResolver?: TransformSecretResolver;
  now?: () => Date;
  randomUuid?: () => string;
  randomInt?: (maximum: number) => number;
  templateValues?: Record<string, unknown>;
  hashOutputEncoding?: HashOutputEncoding;
}

export interface TransformPipelineOptions {
  secretResolver?: TransformSecretResolver;
  now?: () => Date;
  randomUuid?: () => string;
  randomInt?: (maximum: number) => number;
}

export interface TransformValidationError {
  index: number;
  op: string;
  message: string;
  path?: string;
}

export interface TransformValidationResult {
  valid: boolean;
  errors: TransformValidationError[];
}

/**
 * The step outputs that carry money. They are persisted as decimals, never as
 * native floats, so the closed library forbids `to_number` on them.
 */
export const MONETARY_OUTPUT_STORES = ["SETTLED_AMOUNT", "PROVIDER_FEE"] as const;

export type MonetaryOutputStore = (typeof MONETARY_OUTPUT_STORES)[number];

export const isMonetaryOutputStore = (storeAs: string | undefined | null): boolean =>
  typeof storeAs === "string" && (MONETARY_OUTPUT_STORES as readonly string[]).includes(storeAs);

/**
 * A transform usage site: the pipes of a step parameter or a step output and,
 * for outputs, the store the value ends up in.
 */
export interface TransformUsage {
  path: string;
  pipes?: readonly TransformPipe[];
  storeAs?: string;
}

interface DecimalValue {
  negative: boolean;
  coefficient: bigint;
  scale: number;
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const HEX_PATTERN = /^[0-9a-fA-F]*$/;

function decimalToPlainString(value: DecimalValue): string {
  if (value.scale === 0) {
    return `${value.negative ? "-" : ""}${value.coefficient}`;
  }
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, "");
  return `${value.negative && value.coefficient !== 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Renders a value into its decimal literal form. `Prisma.Decimal` and
 * `decimal.js` instances are objects that expose a `toString()` producing the
 * plain decimal literal, so every money value read from the database is
 * accepted without ever touching a native float.
 */
function decimalLiteral(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Decimal value must be finite");
    }
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value && typeof value === "object") {
    const candidate = value as { toString?: () => string };
    if (typeof candidate.toString === "function") {
      const text = candidate.toString();
      if (typeof text === "string") {
        return text;
      }
    }
  }
  throw new Error("Decimal value must be a string, number, bigint, or a decimal-compatible object");
}

function isDecimalCompatible(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return true;
  }
  if (value && typeof value === "object") {
    return typeof (value as { toString?: () => string }).toString === "function";
  }
  return false;
}

function parseDecimal(value: unknown): DecimalValue {
  if (typeof value === "bigint") {
    return { negative: value < 0n, coefficient: value < 0n ? -value : value, scale: 0 };
  }
  const trimmed = decimalLiteral(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal value '${trimmed}'`);
  }
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[2] ?? "0"}${fraction}`);
  return { negative: match[1] === "-", coefficient, scale: fraction.length };
}

function decimalToString(value: DecimalValue): string {
  const sign = value.negative && value.coefficient !== 0n ? "-" : "";
  if (value.scale === 0) {
    return `${sign}${value.coefficient}`;
  }
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale);
  return `${sign}${whole}.${fraction}`;
}

function rescale(value: DecimalValue, scale: number): DecimalValue {
  if (scale === value.scale) {
    return value;
  }
  if (scale > value.scale) {
    return {
      negative: value.negative,
      coefficient: value.coefficient * 10n ** BigInt(scale - value.scale),
      scale,
    };
  }
  return {
    negative: value.negative,
    coefficient: value.coefficient / 10n ** BigInt(value.scale - scale),
    scale,
  };
}

function fixedDecimal(value: DecimalValue, places: number): DecimalValue {
  if (places < 0) {
    throw new Error("Decimal places cannot be negative");
  }
  const scaled = rescale(value, places);
  if (scaled.scale === 0) {
    return scaled;
  }
  const digits = scaled.coefficient.toString().padStart(scaled.scale + 1, "0");
  const whole = digits.slice(0, -scaled.scale);
  const fraction = digits.slice(-scaled.scale).replace(/0+$/, "");
  if (!fraction) {
    return { negative: scaled.negative, coefficient: BigInt(whole), scale: 0 };
  }
  return { negative: scaled.negative, coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function roundDecimal(value: DecimalValue, mode: "NONE" | "NEAREST" | "UP" | "DOWN", places = 0): DecimalValue {
  if (mode === "NONE") {
    return value;
  }
  if (places < 0) {
    throw new Error("Decimal places cannot be negative");
  }
  const divisor = 10n ** BigInt(value.scale);
  const numerator = value.coefficient * 10n ** BigInt(places);
  const negative = value.negative;
  const absolute = numerator < 0n ? -numerator : numerator;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  if (mode === "NEAREST" && remainder * 2n >= divisor) {
    quotient += 1n;
  }
  if (mode === "UP" && remainder > 0n) {
    quotient += 1n;
  }
  return { negative: negative && quotient !== 0n, coefficient: quotient, scale: places };
}

function multiplyInteger(value: DecimalValue, factor: number): DecimalValue {
  if (!Number.isSafeInteger(factor)) {
    throw new Error("Scale factor must be a safe integer");
  }
  return { negative: value.negative, coefficient: value.coefficient * BigInt(factor), scale: value.scale };
}

function divideDecimal(value: DecimalValue, divisorValue: unknown, places: number): DecimalValue {
  const divisor = parseDecimal(divisorValue);
  if (divisor.coefficient === 0n) {
    throw new Error("Decimal divisor cannot be zero");
  }
  const numerator = value.coefficient * 10n ** BigInt(places + divisor.scale);
  const denominator = divisor.coefficient * 10n ** BigInt(value.scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n * 10n ** BigInt(0) >= denominator ? quotient + 1n : quotient;
  return {
    negative: value.negative !== divisor.negative,
    coefficient: rounded,
    scale: places,
  };
}

function asInteger(value: unknown): number {
  const decimal = parseDecimal(value);
  const rounded = roundDecimal(decimal, "DOWN", 0);
  return Number(rounded.coefficient);
}

function formatDecimal(value: unknown, places: number): string {
  const decimal = fixedDecimal(parseDecimal(value), places);
  const negative = decimal.negative && decimal.coefficient !== 0n;
  const digits = decimal.coefficient.toString().padStart(decimal.scale + 1, "0");
  const whole = digits.slice(0, -decimal.scale);
  const fraction = decimal.scale > 0 ? `.${digits.slice(-decimal.scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

function formatDecimalPlaces(value: unknown, places: number): string {
  const decimal = parseDecimal(value);
  const negative = decimal.negative && decimal.coefficient !== 0n;
  const scaled = rescale(decimal, places);
  const digits = scaled.coefficient.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places) || "0";
  const fraction = places > 0 ? `.${digits.slice(digits.length - places)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

function objectEntries(value: unknown): [string, unknown][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Operation requires an object");
  }
  return Object.entries(value as Record<string, unknown>);
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedObject);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = sortedObject((value as Record<string, unknown>)[key]);
  }
  return output;
}

function dateParts(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    values[part.type] = part.value;
  }
  return values;
}

function formatDate(value: unknown, pattern: string, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date value");
  }
  const parts = dateParts(date, timezone);
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, "0");
  return pattern
    .replaceAll("YYYY", parts.year ?? "")
    .replaceAll("MM", parts.month ?? "")
    .replaceAll("DD", parts.day ?? "")
    .replaceAll("HH", parts.hour ?? "")
    .replaceAll("mm", parts.minute ?? "")
    .replaceAll("ss", parts.second ?? "")
    .replaceAll("SSS", milliseconds);
}

function normalizePhone(value: unknown, style: "LOCAL_09" | "INTL_218" | "E164"): string {
  const original = String(value ?? "").trim();
  let digits = original.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (style === "LOCAL_09") {
    if (digits.startsWith("218")) {
      digits = digits.slice(3);
    }
    if (digits.startsWith("0")) {
      digits = digits.slice(1);
    }
    if (digits.length !== 9) {
      throw new Error("Phone number cannot be normalized to local 09 format");
    }
    return `0${digits}`;
  }
  if (digits.startsWith("0")) {
    digits = `218${digits.slice(1)}`;
  }
  if (!digits.startsWith("218")) {
    digits = `218${digits}`;
  }
  if (digits.length !== 12) {
    throw new Error("Phone number cannot be normalized to Libyan format");
  }
  return style === "INTL_218" ? digits : `+${digits}`;
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeKey(value: string | Buffer, encoding: KeyEncoding): Buffer {
  const cryptoEngine = new CryptoEngine();
  return cryptoEngine.constructor
    ? (encoding === "UTF8"
      ? Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8")
      : encoding === "HEX"
        ? Buffer.from(value as string, "hex")
        : Buffer.from(value as string, "base64"))
    : Buffer.from(value as string);
}

function validationError(index: number, op: string, message: string): TransformValidationError {
  return { index, op, message };
}

/**
 * `to_number` produces a native float. Money is never stored as a float, so
 * the rule is refused on the monetary step outputs.
 */
function monetaryTransformErrors(
  pipes: readonly TransformPipe[] | undefined,
  storeAs: string | undefined,
): TransformValidationError[] {
  if (!isMonetaryOutputStore(storeAs) || !Array.isArray(pipes)) {
    return [];
  }
  const errors: TransformValidationError[] = [];
  pipes.forEach((pipe, index) => {
    if (pipe && typeof pipe === "object" && pipe.op === "to_number") {
      errors.push(validationError(
        index,
        "to_number",
        "Money outputs must not use to_number; money is persisted as a decimal, never as a native float",
      ));
    }
  });
  return errors;
}

export const TRANSFORM_OPERATIONS: readonly TransformOperation[] = [
  "scale",
  "MUL_INT",
  "DIV_DECIMAL",
  "round",
  "format_decimal",
  "to_int",
  "to_number",
  "to_string",
  "concat",
  "template",
  "lowercase",
  "uppercase",
  "trim",
  "pad_left",
  "pad_right",
  "substring",
  "mask",
  "prepend",
  "arabic_digits_to_ascii",
  "phone_normalize",
  "sort_keys",
  "values_only",
  "join_pairs",
  "format_date",
  "epoch_seconds",
  "epoch_millis",
  "uuid",
  "numeric_random",
  "base64_encode",
  "hex_lower",
  "hex_upper",
  "url_encode",
  "json_encode",
  "xml_escape",
  "sha256",
  "sha512",
  "hmac_sha256",
  "hmac_sha512",
  "rsa_sha256_sign",
];

export class TransformPipeline {
  private readonly secretResolver?: TransformSecretResolver;
  private readonly now: () => Date;
  private readonly randomUuid: () => string;
  private readonly randomInt: (maximum: number) => number;

  constructor(options: TransformPipelineOptions = {}) {
    this.secretResolver = options.secretResolver;
    this.now = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? randomUUID;
    this.randomInt = options.randomInt ?? ((maximum: number) => secureRandomInt(maximum));
  }

  async apply(value: unknown, pipes: readonly TransformPipe[], context: TransformContext = {}): Promise<unknown> {
    this.assertValid(pipes);
    let current = value;
    for (const pipe of pipes) {
      current = await this.applyOne(current, pipe, {
        ...context,
        secretResolver: context.secretResolver ?? this.secretResolver,
        now: context.now ?? this.now,
        randomUuid: context.randomUuid ?? this.randomUuid,
        randomInt: context.randomInt ?? this.randomInt,
      });
    }
    return current;
  }

  validate(pipes: readonly TransformPipe[]): TransformValidationResult {
    const errors: TransformValidationError[] = [];
    if (!Array.isArray(pipes)) {
      return { valid: false, errors: [validationError(-1, "", "Transform pipeline must be an array")] };
    }
    pipes.forEach((pipe, index) => {
      if (!pipe || typeof pipe !== "object" || typeof pipe.op !== "string") {
        errors.push(validationError(index, String(pipe?.op ?? ""), "Transform pipe must define an operation"));
        return;
      }
      const op = pipe.op as TransformOperation;
      if (!TRANSFORM_OPERATIONS.includes(op)) {
        errors.push(validationError(index, pipe.op, "Transform operation is not in the closed library"));
        return;
      }
      const args = pipe.args ?? [];
      const requireCount = (count: number): void => {
        if (args.length !== count) {
          errors.push(validationError(index, op, `Operation expects ${count} argument(s)`));
        }
      };
      const requireInteger = (position: number, positive = false): void => {
        const candidate = args[position];
        if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || (positive && candidate <= 0)) {
          errors.push(validationError(index, op, `Argument ${position + 1} must be ${positive ? "a positive " : "an " }integer`));
        }
      };
      switch (op) {
        case "scale":
        case "MUL_INT":
          requireCount(1);
          requireInteger(0, true);
          break;
        case "DIV_DECIMAL":
          requireCount(2);
          if (!isDecimalCompatible(args[0])) {
            errors.push(validationError(index, op, "Divisor must be decimal-compatible"));
          }
          requireInteger(1);
          break;
        case "round":
          if (args.length < 1 || args.length > 2) {
            errors.push(validationError(index, op, "Operation expects a rounding mode and an optional decimal place count"));
          }
          if (!["NONE", "NEAREST", "UP", "DOWN"].includes(String(args[0]))) {
            errors.push(validationError(index, op, "Rounding mode is invalid"));
          }
          if (args.length === 2 && (typeof args[1] !== "number" || !Number.isSafeInteger(args[1]) || args[1] < 0 || args[1] > 18)) {
            errors.push(validationError(index, op, "Decimal place count must be an integer between 0 and 18"));
          }
          break;
        case "format_decimal":
          requireCount(1);
          requireInteger(0);
          break;
        case "to_int":
        case "to_number":
        case "to_string":
        case "lowercase":
        case "uppercase":
        case "trim":
        case "arabic_digits_to_ascii":
        case "sort_keys":
        case "values_only":
        case "epoch_seconds":
        case "epoch_millis":
        case "uuid":
        case "base64_encode":
        case "hex_lower":
        case "hex_upper":
        case "url_encode":
        case "json_encode":
        case "xml_escape":
        case "sha256":
        case "sha512":
          requireCount(0);
          break;
        case "concat":
          if (args.length === 0) {
            errors.push(validationError(index, op, "Concat requires at least one value"));
          }
          break;
        case "template":
          requireCount(1);
          if (typeof args[0] !== "string") {
            errors.push(validationError(index, op, "Template pattern must be a string"));
          }
          break;
        case "pad_left":
        case "pad_right":
          requireCount(2);
          requireInteger(0);
          if (typeof args[1] !== "string" || [...args[1]].length !== 1) {
            errors.push(validationError(index, op, "Padding character must contain one character"));
          }
          break;
        case "substring":
          if (args.length !== 1 && args.length !== 2) {
            errors.push(validationError(index, op, "Substring expects one or two indexes"));
          }
          requireInteger(0);
          if (args.length === 2) {
            requireInteger(1);
          }
          break;
        case "mask":
          requireCount(2);
          requireInteger(0);
          requireInteger(1);
          break;
        case "prepend":
        case "rsa_sha256_sign":
          requireCount(1);
          if (typeof args[0] !== "string" || args[0].length === 0) {
            errors.push(validationError(index, op, "Secret reference must be a non-empty string"));
          }
          break;
        case "hmac_sha256":
        case "hmac_sha512":
          if (args.length !== 1 && args.length !== 2) {
            errors.push(validationError(index, op, "Operation expects a key reference and an optional key encoding"));
          }
          if (typeof args[0] !== "string" || args[0].length === 0) {
            errors.push(validationError(index, op, "Secret reference must be a non-empty string"));
          }
          if (args.length === 2 && !["UTF8", "HEX", "BASE64"].includes(String(args[1]))) {
            errors.push(validationError(index, op, "Key encoding must be UTF8, HEX, or BASE64"));
          }
          break;
        case "phone_normalize":
          requireCount(1);
          if (!["LOCAL_09", "INTL_218", "E164"].includes(String(args[0]))) {
            errors.push(validationError(index, op, "Phone normalization style is invalid"));
          }
          break;
        case "join_pairs":
          requireCount(2);
          if (typeof args[0] !== "string" || typeof args[1] !== "string") {
            errors.push(validationError(index, op, "Join separators must be strings"));
          }
          break;
        case "format_date":
          requireCount(2);
          if (typeof args[0] !== "string" || typeof args[1] !== "string") {
            errors.push(validationError(index, op, "Date pattern and timezone must be strings"));
          } else {
            try {
              new Intl.DateTimeFormat("en-CA", { timeZone: args[1] }).format(new Date());
            } catch {
              errors.push(validationError(index, op, "Timezone is invalid"));
            }
          }
          break;
        case "numeric_random":
          requireCount(1);
          requireInteger(0, true);
          break;
      }
    });
    return { valid: errors.length === 0, errors };
  }

  assertValid(pipes: readonly TransformPipe[]): void {
    const result = this.validate(pipes);
    if (!result.valid) {
      throw new Error(result.errors.map((error) => `${error.op}: ${error.message}`).join("; "));
    }
  }

  /**
   * Validates the pipes of a step output against the store the value ends up
   * in. Monetary stores forbid the float producing `to_number` operation.
   */
  validateForStore(pipes: readonly TransformPipe[], storeAs?: string): TransformValidationResult {
    const errors = [...this.validate(pipes).errors, ...monetaryTransformErrors(pipes, storeAs)];
    return { valid: errors.length === 0, errors };
  }

  assertValidForStore(pipes: readonly TransformPipe[], storeAs?: string): void {
    const result = this.validateForStore(pipes, storeAs);
    if (!result.valid) {
      throw new Error(result.errors.map((error) => `${error.op}: ${error.message}`).join("; "));
    }
  }

  private async applyOne(value: unknown, pipe: TransformPipe, context: TransformContext): Promise<unknown> {
    const args = pipe.args ?? [];
    const now = context.now ?? (() => new Date());
    const randomUuid = context.randomUuid ?? randomUUID;
    const randomInt = context.randomInt ?? ((maximum: number) => secureRandomInt(maximum));
    switch (pipe.op) {
      case "scale":
      case "MUL_INT":
        return decimalToPlainString(multiplyInteger(parseDecimal(value), Number(args[0])));
      case "DIV_DECIMAL":
        return decimalToPlainString(divideDecimal(parseDecimal(value), args[0], Number(args[1])));
      case "round": {
        const mode = args[0] as "NONE" | "NEAREST" | "UP" | "DOWN";
        return decimalToPlainString(roundDecimal(parseDecimal(value), mode, args.length > 1 ? Number(args[1]) : 0));
      }
      case "format_decimal":
        return formatDecimalPlaces(value, Number(args[0]));
      case "to_int":
        return asInteger(value);
      case "to_number":
        return Number(String(value));
      case "to_string":
        return String(value ?? "");
      case "concat": {
        const head = value === undefined || value === null ? "" : String(value);
        return `${head}${args.map((part) => String(part ?? "")).join("")}`;
      }
      case "template": {
        const template = String(args[0]);
        const values = context.templateValues ?? {};
        return template.replace(/\{\{([A-Za-z0-9_.-]+)\}\}|\{([A-Za-z0-9_.-]+)\}/g, (_match, doubleKey, singleKey) => {
          const key = String(doubleKey ?? singleKey);
          return String(values[key] ?? "");
        });
      }
      case "lowercase":
        return String(value ?? "").toLowerCase();
      case "uppercase":
        return String(value ?? "").toUpperCase();
      case "trim":
        return String(value ?? "").trim();
      case "pad_left": {
        const text = String(value ?? "");
        const length = Number(args[0]);
        const character = String(args[1]);
        return text.length >= length ? text : character.repeat(length - text.length) + text;
      }
      case "pad_right": {
        const text = String(value ?? "");
        const length = Number(args[0]);
        const character = String(args[1]);
        return text.length >= length ? text : text + character.repeat(length - text.length);
      }
      case "substring": {
        const text = String(value ?? "");
        const start = Number(args[0]);
        const end = args.length > 1 ? Number(args[1]) : undefined;
        return end === undefined ? text.slice(start) : text.slice(start, end);
      }
      case "mask": {
        const text = String(value ?? "");
        const visibleStart = Number(args[0]);
        const visibleEnd = Number(args[1]);
        if (visibleStart + visibleEnd >= text.length) {
          return "*".repeat(text.length);
        }
        return `${text.slice(0, visibleStart)}${"*".repeat(text.length - visibleStart - visibleEnd)}${text.slice(text.length - visibleEnd)}`;
      }
      case "prepend": {
        if (!context.secretResolver) {
          throw new Error("A secret resolver is required for prepend");
        }
        const secret = await context.secretResolver.resolveSecret(String(args[0]));
        return `${Buffer.isBuffer(secret) ? secret.toString("utf8") : secret}${String(value ?? "")}`;
      }
      case "arabic_digits_to_ascii": {
        let text = String(value ?? "");
        for (let index = 0; index < ARABIC_DIGITS.length; index += 1) {
          text = text.replaceAll(ARABIC_DIGITS[index] ?? "", String(index));
          text = text.replaceAll(EASTERN_ARABIC_DIGITS[index] ?? "", String(index));
        }
        return text;
      }
      case "phone_normalize":
        return normalizePhone(value, args[0] as "LOCAL_09" | "INTL_218" | "E164");
      case "sort_keys":
        return sortedObject(value);
      case "values_only":
        return objectEntries(value).map(([, item]) => item);
      case "join_pairs": {
        const pairs = objectEntries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${key}${String(args[0])}${String(item ?? "")}`);
        return pairs.join(String(args[1]));
      }
      case "format_date":
        return formatDate(value ?? now(), String(args[0]), String(args[1]));
      case "epoch_seconds":
        return Math.floor((value instanceof Date ? value : now()).getTime() / 1000);
      case "epoch_millis":
        return (value instanceof Date ? value : now()).getTime();
      case "uuid":
        return randomUuid();
      case "numeric_random": {
        const length = Number(args[0]);
        let output = "";
        for (let index = 0; index < length; index += 1) {
          output += String(randomInt(10));
        }
        return output;
      }
      case "base64_encode":
        return Buffer.from(String(value ?? ""), "utf8").toString("base64");
      case "hex_lower":
        return Buffer.from(String(value ?? ""), "utf8").toString("hex");
      case "hex_upper":
        return Buffer.from(String(value ?? ""), "utf8").toString("hex").toUpperCase();
      case "url_encode":
        return encodeURIComponent(String(value ?? ""));
      case "json_encode":
        return JSON.stringify(value);
      case "xml_escape":
        return xmlEscape(value);
      case "sha256":
        return createHash("sha256").update(String(value ?? "")).digest("hex");
      case "sha512":
        return createHash("sha512").update(String(value ?? "")).digest("hex");
      case "hmac_sha256":
      case "hmac_sha512": {
        if (!context.secretResolver) {
          throw new Error("A secret resolver is required for HMAC transforms");
        }
        const keyEncoding = (args[1] as KeyEncoding | undefined) ?? "UTF8";
        const secret = await context.secretResolver.resolveSecret(String(args[0]));
        const algorithm = pipe.op === "hmac_sha256" ? "sha256" : "sha512";
        const digest = createHmac(algorithm, decodeKey(secret, keyEncoding)).update(String(value ?? "")).digest();
        return encodeDigest(digest, context.hashOutputEncoding);
      }
      case "rsa_sha256_sign": {
        if (!context.secretResolver) {
          throw new Error("A secret resolver is required for RSA transforms");
        }
        const key = await context.secretResolver.resolveSecret(String(args[0]));
        const cryptoEngine = new CryptoEngine();
        return cryptoEngine.rsaSha256Sign(key, String(value ?? ""), context.hashOutputEncoding ?? "BASE64");
      }
    }
  }
}

function encodeDigest(value: Buffer, encoding: HashOutputEncoding | undefined): string {
  if (encoding === "BASE64") {
    return value.toString("base64");
  }
  if (encoding === "HEX_UPPER") {
    return value.toString("hex").toUpperCase();
  }
  return value.toString("hex");
}

export function validateTransformPipes(pipes: readonly TransformPipe[]): TransformValidationResult {
  return new TransformPipeline().validate(pipes);
}

export function assertValidTransformPipes(pipes: readonly TransformPipe[]): void {
  new TransformPipeline().assertValid(pipes);
}

/**
 * Validates every transform usage of a declarative definition (the pipes of
 * the step parameters and of the step outputs) in one pass. The save paths use
 * it to refuse a broken pipe while the gateway version is being configured
 * instead of when a live payment executes.
 */
export function validateTransformUsage(usages: readonly TransformUsage[]): TransformValidationResult {
  const pipeline = new TransformPipeline();
  const errors: TransformValidationError[] = [];
  for (const usage of usages) {
    const result = pipeline.validateForStore(usage.pipes ?? [], usage.storeAs);
    for (const error of result.errors) {
      errors.push({ ...error, path: usage.path });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertValidTransformUsage(usages: readonly TransformUsage[]): void {
  const result = validateTransformUsage(usages);
  if (!result.valid) {
    throw new Error(
      result.errors
        .map((error) => `${error.path ? `${error.path}: ` : ""}${error.op}: ${error.message}`)
        .join("; "),
    );
  }
}
