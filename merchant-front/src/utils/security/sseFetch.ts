/**
 * Minimal SSE-over-fetch reader. Unlike EventSource it can send an Authorization header,
 * so the bearer token never has to travel in a query string and the stream is not anonymous.
 */
export type SseFrame = { event: string; data: string };

/** Incremental parser: feed text chunks, get completed frames. */
export const createSseParser = (onFrame: (frame: SseFrame) => void) => {
    let buffer = "";
    return (chunk: string) => {
        buffer += chunk.replace(/\r\n?/g, "\n");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of raw.split("\n")) {
                if (!line || line.startsWith(":")) {
                    continue;
                }
                const sep = line.indexOf(":");
                const field = sep === -1 ? line : line.slice(0, sep);
                const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
                if (field === "event") {
                    event = value;
                } else if (field === "data") {
                    data.push(value);
                }
            }
            if (data.length) {
                onFrame({ event, data: data.join("\n") });
            }
        }
    };
};

export type SseStreamOptions = {
    url: string;
    headers?: Record<string, string>;
    onOpen?: () => void;
    onFrame: (frame: SseFrame) => void;
    onClose?: (error?: unknown) => void;
    fetchImpl?: typeof fetch;
};

/** Opens the stream; returns `close()`. `onClose` fires once when the stream ends or fails. */
export const openSseStream = (opts: SseStreamOptions) => {
    const controller = new AbortController();
    const doFetch = opts.fetchImpl ?? fetch;
    void (async () => {
        try {
            const response = await doFetch(opts.url, {
                headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
                signal: controller.signal,
                credentials: "omit",
                cache: "no-store",
            });
            if (!response.ok || !response.body) {
                throw new Error(`stream http ${response.status}`);
            }
            opts.onOpen?.();
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const feed = createSseParser(opts.onFrame);
            for (;;) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                feed(decoder.decode(value, { stream: true }));
            }
            opts.onClose?.();
        } catch (error) {
            if (!controller.signal.aborted) {
                opts.onClose?.(error);
            }
        }
    })();
    return { close: () => controller.abort() };
};
