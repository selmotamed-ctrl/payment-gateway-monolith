/**
 * Reads the stable error contract of the API out of whatever an HTTP client threw:
 * `{ code, message, details? }`, optionally wrapped in `error` / `data`. Pure (no axios import) so it is unit-testable.
 */
export type ApiErrorInfo = {
    status: number;
    code: string;
    message: string;
    details: Record<string, unknown> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const readApiErrorInfo = (error: unknown): ApiErrorInfo => {
    const response = isRecord(error) && isRecord(error.response) ? error.response : null;
    const status = response && typeof response.status === "number" ? response.status : 0;
    const payload = response?.data;
    const layers: Record<string, unknown>[] = [];
    if (isRecord(payload)) {
        layers.push(payload);
        if (isRecord(payload.error)) layers.push(payload.error);
        if (isRecord(payload.data)) layers.push(payload.data);
    }
    let code = "";
    let message = "";
    let details: Record<string, unknown> | null = null;
    for (const layer of layers) {
        if (!code && typeof layer.code === "string") code = layer.code;
        if (!message && typeof layer.message === "string") message = layer.message;
        if (!message && typeof layer.error === "string") message = layer.error;
        if (!details && isRecord(layer.details)) details = layer.details;
    }
    return { status, code, message, details };
};

export const detailList = (details: Record<string, unknown> | null, key: string): string[] => {
    const value = details?.[key];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
};
