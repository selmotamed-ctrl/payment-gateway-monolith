import { isEmpty } from "../clientValidationRules";

type Key = string | number;

function parsePath(path: string): Key[] {
    return path
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter(Boolean)
        .map((k) => (k.match(/^\d+$/) ? Number(k) : k));
}

export function rks(target: any, path: string, value: any): void {
    const keys = parsePath(path);

    function set(obj: any, i: number): void {
        const key = keys[i]!;
        const nextKey = keys[i + 1];

        if (i === keys.length - 1) {
            obj[key] = value;
            return;
        }

        if (obj[key] == null) {
            obj[key] = typeof nextKey === "number" ? [] : {};
        }

        set(obj[key], i + 1);
    }

    set(target, 0);
}
