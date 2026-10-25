// eslint-disable no-useless-escape
// eslint-disable no-control-regex
import { adaptedLocale } from "@/plugins/localization";
import { capitalize } from "@/utils/common/index";

export const isEmpty = (value: any) => {
    return value === "" || value === null || value === undefined;
};

export const rules = {
    countryPhoneCode() {
        const t = adaptedLocale.t;
        return function countryPhoneCode(v: any) {
            if (isEmpty(v)) {
                return true;
            }
            if (typeof v != "string") {
                return t("Country phone Code Must Be A String");
            }
            if (!v.match(/^[1-9][0-9]{1,3}$/)) {
                return t("Country phone code must be one to four numbers not starting with 0");
            }

            return true;
        };
    },

    countryIso2Code() {
        const t = adaptedLocale.t;
        return function countryIso2Code(v: any) {
            if (isEmpty(v)) {
                return true;
            }
            if (typeof v != "string") {
                return t("Country Code Must Be A String");
            }
            if (!v.match(/^[A-Z]{2}$/)) {
                return t("Country code must be 2 uppercase english letters");
            }

            return true;
        };
    },

    currencyNumericCode() {
        const t = adaptedLocale.t;
        return function currencyNumericCode(v: any) {
            if (typeof v != "string") {
                return t("Currency Numeric Code Must be a string");
            }
            if (!v.match(/^\d{3}$/)) {
                return t("currency Numeric Code must be 3 Digits");
            }
            return true;
        };
    },
    currencyAlphabeticCode() {
        const t = adaptedLocale.t;
        return function currencyAlphabeticCode(v: any) {
            if (typeof v != "string") {
                return t("Currency Alphabetic Code Must be a string");
            }
            if (!v.match(/^[A-Z]{3}$/)) {
                return t("currency Alphabetic Code must be 3 Upper case english characters");
            }
            return true;
        };
    },
    currencyName() {
        const t = adaptedLocale.t;
        return function currencyName(v: any) {
            if (typeof v != "string") {
                return t("Currency Name Must be a string");
            }
            if (!v.match(/^[a-z]$|^[a-z][a-z0-9\s\-]*?[a-z0-9]$/i)) {
                return t("currency name must start with english character and continue with either characters, numbers or spaces and `-` in between");
            }
            return true;
        };
    },
    subdomain() {
        const t = adaptedLocale.t;
        return function subdomain(v: any) {
            if (isEmpty(v)) {
                return true;
            }

            if (typeof v != "string") {
                return t("Subdomain must be a string");
            }

            if (!v.match(/^[a-zA-Z_][a-zA-Z\-_0-9]*?$/)) {
                return t("Subdomain must start with an underscore or an english letter followed by english letters, numbers, underscore, or hyphen");
            }

            return true;
        };
    },
    filePrefix() {
        const t = adaptedLocale.t;
        return function subdomain(v: any) {
            if (isEmpty(v)) {
                return true;
            }

            if (typeof v != "string") {
                return t("Prefix must be a string");
            }

            if (!v.match(/^[a-zA-Z_][a-zA-Z\-_0-9]*?$/)) {
                return t("Prefix must start with an underscore or an english letter followed by english letters, numbers, underscore, or hyphen");
            }

            return true;
        };
    },
    referencePrefix() {
        const t = adaptedLocale.t;
        return function referencePrefix(v: any) {
            if (isEmpty(v)) {
                return true;
            }

            if (typeof v != "string") {
                return t("Reference Prefix must be a string");
            }

            return !!v.match(/^[A-Z]{5}$/) || t("Reference Prefix 5 Upper Case English Characters");
        };
    },

    accountGL() {
        const t = adaptedLocale.t;
        return function accountGL(v: any) {
            if (isEmpty(v)) {
                return true;
            }

            if (typeof v != "string") {
                return t("Account GL must be a string");
            }

            return !!v.match(/^[0-9]{6,18}(LYD|USD)$/) || t("Account GL must be 6 to 18 numbers followed by either LYD or USD");
        };
    },
    templateName(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function templateName(v: any) {
            if (isEmpty(v)) {
                return true;
            }

            if (typeof v != "string") {
                return t("Template Name must be a string");
            }

            return !!v.match(/^[A-Za-z][A-Za-z0-9]{5,20}$/) || t("invalid template name, it must be a single word from 5 to 20 characters in length");
        };
    },
    ipAndHostname(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return (value: any) => {
            if (isEmpty(value)) {
                return true;
            }
            const msg = `${field} is not valid a hostname address`;
            try {
                const regex =
                    /^\blocalhost|(((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,}){1,}))\b$/i;
                if (typeof value != "string") {
                    return msg;
                }
                if (!value.match(regex)) {
                    return msg;
                }
                return true;
            } catch {
                return msg;
            }
        };
    },
    tokenName(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return (v: string) => {
            if (isEmpty(v)) {
                return true;
            }

            const msg = `${field} ${t("is not a valid token name")}`;
            try {
                return !!v.match(/^[A-Za-z0-9][A-Za-z0-9_-]{3,}$/) || msg;
            } catch {
                return msg;
            }
        };
    },
    inValues: (field: string, source_list: Array<any>) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function inValues(value: any) {
            if (value === null || value === undefined || value === "") {
                return true;
            }
            return !!source_list?.includes(value) || `${t(field)} ${t("must be one of required values")}`;
        };
    },
    macAddress: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function macAddress(v: string) {
            if (isEmpty(v)) {
                return true;
            }

            const msg = `${field} ${t("is invalid mac address")}`;

            try {
                return !!v.trim().match(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/) || msg;
            } catch {
                return msg;
            }
        };
    },

    notInValues: (field: string, source_list: Array<any>) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function inValues(value: any) {
            if (value === null || value === undefined || value === "") {
                return true;
            }
            return !source_list?.includes(value) || `${t(field)} ${t("must be one of the allowed values")}`;
        };
    },
    boolean(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function boolean(value: any) {
            if (value === true || value === false || value === 0 || value === 1) {
                return true;
            }
            return `${t(field)} ${t(`must Valid Boolean`)}`;
        };
    },

    required: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function required(value: any) {
            const message = `${t(field)} ${t("is required")}`;
            if (typeof value == "object" && Array.isArray(value)) {
                return !!value.length || message;
            } else {
                const result = !isEmpty(value) || message;
                return result;
            }
        };
    },

    taxNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function TaxNumber(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9a-zA-Z]{3,20}$/) || t(`invalid tax number, must be between 3 and 20 number or english characters`);
        };
    },

    commercialRegistryNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function commercialRegistryNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return (
                !!String(value).match(/^[0-9a-zA-Z]{3,20}$/) || t(`invalid commercial registry number, must be between 3 and 20 number or english characters`)
            );
        };
    },

    commercialChamberNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function commercialChamberNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return (
                !!String(value).match(/^[0-9a-zA-Z]{3,20}$/) || t(`invalid Commercial Chamber number, must be between 3 and 20 number or english characters`)
            );
        };
    },
    commercialNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function commercialNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9a-zA-Z]{3,20}$/) || t(`invalid commercial number, must be between 3 and 20 number or english characters`);
        };
    },
    // ^\d{3}$
    branchNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function branchNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^\d{3}$/) || t(`invalid branch number, must be 3 numbers`);
        };
    },

    // ^\d{15}$
    accountNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function accountNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^\d{15}$/) || t(`invalid account number, must be 15 number`);
        };
    },

    settingsAccountNo: () => {
        const t = adaptedLocale.t;
        return function settingsAccountNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9]{9}(LYD|USD)$/) || t(`invalid account number, must be 9 numbers followed by "LYD" or "USD" `);
        };
    },

    //^[0-9A-Z]{3,8}$
    accountClass: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function accountClass(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9A-Z]{3,8}$/) || t(`invalid account number, must be 3 to 8 numbers and Upper case English characters`);
        };
    },

    //^LY[0-9]{23}$
    iban: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function iban(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^LY[0-9]{23}$/) || t(`invalid account number, must start with "LY" and 23 number`);
        };
    },

    identificationNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function identificationNumber(value: string) {
            if (isEmpty(value)) {
                return true;
            }
            return !!String(value).match(/^[0-9A-Z]{4,12}$/) || t("Invalid Identification Number, must be 4 to 12 Numbers and Upper Case English characters");
        };
    },

    residencePermitNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function residencePermitNumber(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return (
                !!String(value).match(/^[0-9A-Z]{3,25}$/) ||
                `this is not valid residence permit number, it should only contain upper case english characters or numbers`
            );
        };
    },

    identificationOnlyNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function identificationOnlyNumber(value: string) {
            if (isEmpty(value)) {
                return true;
            }
            return !!String(value).match(/^[0-9]{4,12}$/) || t("Invalid Identification Number, must be 4 to 12 Numbers");
        };
    },

    licenseNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function licenseNo(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9a-zA-Z]{3,20}$/) || t(`invalid license number, must be between 3 and 20 number or english characters`);
        };
    },

    nationalIdNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function NationalIdNumber(value: string) {
            if (isEmpty(value)) {
                return true;
            }
            return !!String(value).match(/^[12][0-9]{11}$/) || t(field) + t(" is invalid, must only contain characters and be 12 in length");
        };
    },
    description: (field: string, max_length = 1e4, min_length = 0) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function title(value: any) {
            if (isEmpty(value)) {
                return true;
            }

            if (typeof value != "string") {
                return `${field} must be a string`;
            }

            if (value.length > max_length) {
                return `${field} must be less then ${max_length} in length`;
            }
            if (min_length && value.length < min_length) {
                return `${field} must be greater then ${min_length} in length`;
            }

            return true;
        };
    },
    employeeNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function employeeNumber(value: any) {
            if (isEmpty(value)) {
                return true;
            }

            return !!String(value).match(/^[0-9]{3,10}$/) || "invalid employee id, must be a number (digits) between 3 to 10 and length";
        };
    },
    title: (field: string, max_length = 250, min_length = 0) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function title(value: any) {
            if (isEmpty(value)) {
                return true;
            }

            if (typeof value != "string") {
                return `${t(field)} ${t("must be a string")}`;
            }

            if ((typeof max_length == "number" && max_length === min_length && value.length < max_length) || value.length > max_length) {
                return `${t(field)} ${t("must equals")} ${max_length} ${t("in length")}`;
            }

            if (value.length > max_length) {
                return `${field} ${t("must be less then or equals")} ${max_length} ${t("in length")}`;
            }
            if (min_length && value.length < min_length) {
                return `${field} ${t("must be greater then or equals")} ${min_length} ${t("in length")}`;
            }

            return true;
        };
    },
    hex: (field: string, max_length = 250, min_length = 0) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function hex(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            if (typeof value != "string") {
                return `${field} must be a string`;
            }
            if (value.length > max_length) {
                return `${field} must be less then ${max_length} in length`;
            }
            if (min_length && value.length < min_length) {
                return `${field} must be greater then ${min_length} in length`;
            }
            if (!value.match(/^[A-Fa-f0-9]*$/)) {
                return `${field} must be valid hex containing only '0' to '9' and 'a' to 'f'`;
            }
            return true;
        };
    },
    name: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function name(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            try {
                return !!value.trim().match(/^(?:(\p{L}{1,})\s)*?(\p{L}{1,})$/iu) || `${field} is not valid name`;
            } catch {
                return `${field} is not valid name`;
            }
        };
    },
    email: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function email(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            try {
                return (
                    !!value
                        .trim()
                        .match(
                            /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/,
                        ) || `${t(field)} ${t("is not valid email")}`
                );
            } catch {
                return `${t(field)} ${t("is not valid email")}`;
            }
        };
    },
    senderId: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function senderId(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            try {
                return value.trim().match(/^[\p{L}0-9][\p{L} ,-_\/\|0-9]{0,}[\p{L}0-9]$/iu) || `invalid sender id`;
            } catch {
                return `invalid sender id`;
            }
        };
    },
    entityNameEn: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function entityNameEn(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            try {
                return !!value.match(/^[a-zA-Z][a-zA-Z\s]{4,}$/) || `${t("English Entity Name is not valid, is must be only English Characters and spaces")}`;
            } catch (error) {
                console.error(error);
                return `${t("English Entity Name is not valid, is must be only English Characters and spaces")}`;
            }
        };
    },

    onlyArabic: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function onlyArabic(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            const message = `${t(`${field} must contain only Arabic Characters and spaces`)}`;
            try {
                return !!value.match(/^[\u0600-\u06ff][\u0600-\u06ff\s]*?$/iu) || message;
            } catch (error) {
                console.error(error);
                return message;
            }
        };
    },

    onlyEnglish: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function onlyArabic(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            const message = `${t(`${field} must contain only Arabic Characters and spaces`)}`;
            try {
                return !!value.match(/^[a-zA-Z][a-zA-Z\s]*?$/iu) || message;
            } catch (error) {
                console.error(error);
                return message;
            }
        };
    },

    entityNameAr: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function entityNameAr(value: string) {
            if (isEmpty(value)) {
                return true;
            }

            const message = `${t("Arabic Entity Name is not valid, is must be only Arabic Characters and spaces")}`;
            try {
                return !!value.match(/^[\u0600-\u06ff][\u0600-\u06ff\s]{4,}$/iu) || message;
            } catch (error) {
                console.error(error);
                return message;
            }
        };
    },
    passportNo: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function passportNo(value: string | null) {
            if (isEmpty(value)) {
                return true;
            }
            try {
                return !!value?.trim().match(/^[0-9A-Z]{4,12}$/iu) || `${t(field)} ${t("is not valid passport number")}`;
            } catch {
                return `${t(field)} ${t("is not valid passport number")}`;
            }
        };
    },
    identityNumber: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function identityNumber(v: string) {
            if (isEmpty(v)) {
                return true;
            }
            try {
                return !!v.trim().match(/^[0-9]{4,12}$/iu) || `${t(field)} ${t("is not valid identity number")}`;
            } catch {
                return `${t(field)} ${t("is not valid identity number")}`;
            }
        };
    },
    phone: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function phone(value: any) {
            if (isEmpty(value)) {
                return true;
            }

            value = String(value);
            console.log("Validating phone number", value);

            try {
                return !!value.trim().match(/^(?:00218|\+218|0)?(9(?:1|2|3|4|5)[0-9]{7})$/iu) || `${t(field)} ${t("is not valid phone")}`;
            } catch {
                return `${t(field)} ${t("is not valid phone")}`;
            }
        };
    },
    password: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function password(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            return (typeof value == "string" && value.length > 6 && value.length < 22) || `${t(field)} ${t("is not valid password")}`;
        };
    },
    username: (field: string) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function username(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            try {
                return !!value.trim().match(/^[a-z][a-z0-9]{3,}$/) || `${t(field)} ${t("is not valid username")}`;
            } catch {
                return `${t(field)} ${t("is not valid username")}`;
            }
        };
    },
    number: (field: string, inclusiveMax?: number, inclusiveMin?: number) => {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function number(value: any) {
            if (isEmpty(value)) {
                return true;
            }
            const msg = `${field} is not a valid number`;
            try {
                const number_value = parseFloat(value);
                if (Number.isNaN(number_value)) {
                    return msg;
                }

                if (typeof inclusiveMax === "number" && number_value > inclusiveMax) {
                    return `${field} must be less then ${inclusiveMax}`;
                }

                if (typeof inclusiveMin === "number" && number_value < inclusiveMin) {
                    return `${field} must be greater then ${inclusiveMin}`;
                }
                return true;
            } catch {
                return msg;
            }
        };
    },
    confirmPassword(field: string, password: null | string) {
        return (v: any) => {
            return password === undefined || password === null || v === password || `${field} does not match password`;
        };
    },

    url(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function url(v: string) {
            if (isEmpty(v)) {
                return true;
            }
            const msg = `${field} ${t("is not a valid url")}`;
            try {
                return (
                    !!v.trim().match(/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}(?:\.[a-zA-Z0-9()]{1,6})*?\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*?)$/i) || msg
                );
            } catch {
                return msg;
            }
        };
    },
    baseUrl(field: string) {
        field = capitalize(field);
        const t = adaptedLocale.t;
        return function baseUrl(v: string) {
            if (isEmpty(v)) {
                return true;
            }
            const msg = `${field} ${t("is not a base valid url")}`;
            try {
                return !!v.trim().match(/^https?:\/\/[^\\\/]+$/) || msg;
            } catch {
                return msg;
            }
        };
    },
    //^https?:\\/\\/[^\\/]+
} satisfies {
    [key: string]: ((field: string, ...args: any) => Rule) | ((...args: any) => Rule);
};

export type Rule = (v: any) => string | true;
export type RulesList = Rule[];

export const createValidator = <
    R extends {
        [key: string]: ((v: any) => string | boolean)[] | undefined;
    },
>(
    rules: R,
) => {
    return (values: { [key in keyof R]: any }) => {
        const errors: { [key in keyof R]: string | undefined } = {} as any;
        for (const key in values) {
            const fieldRules = rules[key];
            for (const rule of fieldRules || []) {
                if (!rule || typeof rule != "function") {
                    console.log("rule is not function", rule);
                    continue;
                }
                const validationResult = rule?.(values[key]);
                if (typeof validationResult === "string") {
                    errors[key] = validationResult;
                    break;
                }
            }
        }
        return errors;
    };
};
