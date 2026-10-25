import { adaptedLocale } from "@/plugins/localization";

export type Merge<T, U> = T & Omit<U, keyof T>;

export const sleep = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};

export const isEmpty = (value: any) => {
    return value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length);
};

export function base64ToB64DataUrl(base64: string, mime = 'image/png'): string {
  return `data:${mime};base64,${base64}`;
}

export const _1kb = 1024;
export const _1mb = _1kb * 1024;
export const _1gb = _1mb * 1024;

export const bytesValueToReadable = (bytes: number | undefined) => {
    if (!bytes) {
        return "";
    }
    if (Math.floor(bytes / _1gb)) {
        return `${(bytes / _1gb).toFixed(2)} GB`;
    }

    if (Math.floor(bytes / _1mb)) {
        return `${(bytes / _1mb).toFixed(2)} MB`;
    }

    if (Math.floor(bytes / _1kb)) {
        return `${(bytes / _1kb).toFixed(2)} KB`;
    }

    return `${bytes} Bytes`;
};

/**
 * Make all properties in T optional
 */
export type Nullable<T> = {
    [P in keyof T]: T[P] | null;
};

export function copyToClipboard(text: string) {
    try {
        navigator.clipboard.writeText(text);
    } catch (error) {
        console.log("Default Copy Approach Error", error);

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed"; // Prevent scrolling to bottom
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();

        try {
            const successful = document.execCommand("copy");
            console.log(successful ? "Copied!" : "Copy failed");
        } catch (err) {
            console.error("Fallback copy error:", err);
        }
        document.body.removeChild(textarea);
    }
}

export function openInNewTab(url: string) {
    window.open(url, "_blank")?.focus();
}

export function recursiveSelect(selector: string | string[], obj: any): any {
    if (typeof selector == "string") {
        selector = selector.split(".").filter((s) => !!s);
    }

    if (!selector || !selector.length) {
        return obj;
    }
    try {
        return recursiveSelect(selector.slice(1), obj[selector[0]!]);
    } catch {
        return undefined;
    }
}

export const rs = recursiveSelect;

export function clip(text: string, max_length: number): string {
    if (!text) {
        return "";
    }
    if (text.length > max_length) {
        return `${text.slice(0, max_length - 3)}...`;
    } else {
        return text;
    }
}

export function fixed(value: string | number, n = 2) {
    return Number(Number(value).toFixed(n));
}

export const splitConcatenatedWords = (phrase: string) => {
    return phrase.replaceAll(/(?<=[A-Z][a-z]+?)(?=[A-Z])/g, " ");
};

export const capitalize = (inputString: string) => {
    if (!inputString) {
        return inputString;
    }
    try {
        let string = inputString.replaceAll(/\b([a-zA-Z]+)\b/g, (word) => {
            return word[0]!.toUpperCase() + word.toLocaleLowerCase().slice(1);
        });
        return string;
    } catch {
        return inputString;
    }
};

const padStart = (string: string, targetLength: number, padString: string) => {
    targetLength = targetLength >> 0;
    string = String(string);
    padString = String(padString);

    if (string.length > targetLength) {
        return String(string);
    }

    targetLength = targetLength - string.length;

    if (targetLength > padString.length) {
        padString += padString.repeat(targetLength / padString.length);
    }

    return padString.slice(0, targetLength) + String(string);
};

const padDate = (n: string, length = 2) => padStart(n, length, "0");

export const yesNo = (flag: boolean) => {
    return flag ? adaptedLocale.t("Yes") : adaptedLocale.t("No");
};

export const path = {
    join: function pathJoin(...args: string[]) {
        return args
            .map((part, i) => {
                if (i === 0) {
                    return part.trim().replace(/[/\\]+$/, ""); // Trim trailing slashes for the first part
                } else {
                    return part.trim().replace(/(^[/\\]+|[/\\]+$)/g, ""); // Trim both leading and trailing slashes for other parts
                }
            })
            .filter(Boolean) // Remove empty strings
            .join("/");
    },
};

export const isNumber = function (num: any): num is number {
    if (typeof num === "number") {
        return num - num === 0;
    }
    if (typeof num === "string" && num.trim() !== "") {
        return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);
    }
    return false;
};

export function normalizePhoneNumber(phone?: string | null) {
    if (!phone) {
        return "";
    }

    const match = phone.match(/(9[1-5][0-9]{7})/i);
    if (!match) {
        return "";
    }
    return "0" + match[1];
}

export function dashDateFormatter(
    date: Date | string | null | undefined,
    config: {
        getDate?: boolean;
        getTime?: boolean;
        dateFormat: "mm-yyyy" | "yyyy-mm" | "yyyy-mm-dd";
    },
): string {
    if (!date) {
        return "";
    }
    date = new Date(date);
    const month = padDate(String(date.getMonth() + 1));
    const dayOfMonth = padDate(String(date.getDate()));
    const fullYear = date.getFullYear();
    const hour = padDate(String(date.getHours()));
    const minutes = padDate(String(date.getMinutes()));
    const seconds = padDate(String(date.getSeconds()));

    const timeString = `${hour}:${minutes}:${seconds}`;
    let dateString: string;
    if (config?.dateFormat === "mm-yyyy") {
        dateString = `${month}-${fullYear}`;
    } else if (config?.dateFormat === "yyyy-mm") {
        dateString = `${fullYear}-${month}`;
    } else {
        dateString = `${fullYear}-${month}-${dayOfMonth}`;
    }

    if (config?.getDate && config?.getTime) {
        return adaptedLocale.current.value == "ar" ? `${timeString} ${dateString}` : `${dateString} ${timeString}`;
    } else if (config?.getDate && !config?.getTime) {
        return dateString;
    } else {
        return timeString;
    }
}

const englishLetters = "abcdefghijklmnopqrstuvwxyz";
export const generateRandomString = (n: number) => {
    return [...Array(n)]
        .map(() => {
            return englishLetters[Math.floor(Math.random() * englishLetters.length)];
        })
        .join("");
};

export const generateRandomNumber = (n: number) => {
    return [...Array(n)]
        .map(() => {
            return String(Math.floor(Math.random() * 10));
        })
        .join("");
};


export declare type JsonValue = string | number | boolean | JsonObject | JsonArray | null;
export declare interface JsonArray extends Array<JsonValue> {}
export declare type JsonObject = {
    [Key in string]?: JsonValue;
};
