import type { CostModelErrorCode } from "./model/costModel";
import type { ScopeErrorCode } from "./model/routeScope";
import type { MaintenanceWindowErrorCode } from "./model/maintenanceWindows";
import type { ParserConfigErrorCode } from "./model/parserConfig";
import type { AmlParamErrorCode } from "./model/amlRules";
import type { SettingErrorCode } from "./model/settingsSchemas";
import type { LogoFileError } from "./model/assets";

/**
 * English validation messages of the builder models, keyed by error code.
 * Every value is also a key of `constants/i18n/builders.ts` (translated at render time with `t`).
 */
export const COST_ERROR_MESSAGES: Record<CostModelErrorCode, string> = {
    FLAT_INVALID: "Enter a flat fee such as 0.500 (up to 4 decimals).",
    PERCENT_INVALID: "Enter a percentage such as 1.25 (up to 4 decimals).",
    PERCENT_OVER_100: "A percentage cannot exceed 100.",
    MIN_INVALID: "Enter a valid minimum fee.",
    MAX_INVALID: "Enter a valid maximum fee.",
    MIN_GT_MAX: "The minimum fee cannot be higher than the maximum fee.",
    TIERS_REQUIRED: "A tiered or hybrid cost model needs at least one tier.",
    TIER_UP_TO_INVALID: "Enter a valid upper bound for this tier.",
    TIER_UP_TO_ORDER: "Tier upper bounds must increase from one tier to the next.",
    TIER_UP_TO_REQUIRED: "Only the last tier may leave the upper bound empty.",
    TIER_FLAT_INVALID: "Enter a valid flat fee for this tier.",
    TIER_PERCENT_INVALID: "Enter a valid percentage (0 to 100) for this tier.",
    TIER_EMPTY: "This tier is empty: fill in a bound or a fee, or remove it.",
};

export const SCOPE_ERROR_MESSAGES: Record<ScopeErrorCode, string> = {
    MERCHANT_ID_INVALID: "Merchant ids must be UUIDs.",
    APPLICATION_ID_INVALID: "Application ids must be UUIDs.",
    RISK_TIER_INVALID: "Unknown risk tier.",
    CHANNEL_INVALID: "Unknown channel.",
};

export const MISMATCH_ERROR_MESSAGE = "Enter a valid tolerance amount such as 0.0500.";

export const WINDOW_ERROR_MESSAGES: Record<MaintenanceWindowErrorCode, string> = {
    START_REQUIRED: "Enter the start of the window.",
    END_REQUIRED: "Enter the end of the window.",
    START_INVALID: "The start is not a valid date and time.",
    END_INVALID: "The end is not a valid date and time.",
    END_NOT_AFTER_START: "The end must be after the start.",
    OVERLAP: "This window overlaps another window.",
};

export const PARSER_ERROR_MESSAGES: Record<ParserConfigErrorCode, string> = {
    FORMAT_INVALID: "Choose a supported statement format.",
    ENCODING_INVALID: "Choose a supported encoding.",
    DELIMITER_REQUIRED: "A CSV statement needs a delimiter.",
    DELIMITER_LENGTH: "The delimiter must be exactly one character.",
    AMOUNT_REQUIRED: "No amount column is mapped: the statement column named amount is assumed.",
    REFERENCE_REQUIRED: "No reference column is mapped: rows cannot be matched to payments.",
    COLUMN_DUPLICATE: "Two fields read the same statement column.",
    CURRENCY_INVALID: "Use a three-letter currency code.",
    TIMEZONE_INVALID: "Unknown time zone. Use an IANA name such as Africa/Tripoli.",
};

export const AML_PARAM_ERROR_MESSAGES: Record<AmlParamErrorCode, string> = {
    REQUIRED: "This value is required.",
    MONEY_INVALID: "Enter an amount with up to 4 decimals.",
    INTEGER_INVALID: "Enter a whole number.",
    NUMBER_INVALID: "Enter a number.",
    RANGE: "The value is outside the allowed range.",
    OPTION_INVALID: "Choose one of the listed options.",
    CURRENCY_INVALID: "Use a three-letter currency code.",
    ENTRY_INVALID: "One of the entries has an invalid format.",
    AT_LEAST_ONE_LIMIT: "Set a maximum amount, a maximum count, or both.",
};

export const SETTING_ERROR_MESSAGES: Record<SettingErrorCode, string> = {
    REQUIRED: "This value is required.",
    INTEGER: "Enter a whole number.",
    NUMBER: "Enter a number.",
    MONEY: "Enter an amount with up to 4 decimals.",
    RANGE: "The value is outside the allowed range.",
    OPTION: "Choose one of the listed options.",
    CURRENCY: "Use a three-letter currency code.",
};

export const LOGO_ERROR_MESSAGES: Record<LogoFileError, string> = {
    TYPE: "Only PNG or SVG logos are accepted.",
    EMPTY: "The file is empty.",
    TOO_LARGE: "The logo must be 2 MB or smaller.",
    NAME: "The file name is not valid.",
};
