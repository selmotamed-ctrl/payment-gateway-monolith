import type * as TemplateDownload from "./templateDownload";
import type { UploadResponse, XlsxHeader } from "./templateDownload";

/**
 * The shared spreadsheet pipeline (exceljs + xlsx + file-saver, about 1.3 MB in the build).
 *
 * It is a LAZY facade: nothing here imports the heavy module statically, so a page (and every page that merely
 * contains a table with an export button) no longer ships the library with its own chunk. The first export or
 * upload click loads `./templateDownload` once; the functions were already async, so callers see no difference.
 * Type imports are erased by the compiler and cost nothing at runtime.
 *
 * Do not add a static `import ... from "./templateDownload"` (or from exceljs/xlsx) here or anywhere else in
 * `src`: `tests/unit/admin-xlsx-lazy.test.ts` fails if the library is reachable without a dynamic import.
 */
type Pipeline = typeof TemplateDownload;

let loaded: Promise<Pipeline> | undefined;
const load = (): Promise<Pipeline> => (loaded ??= import("./templateDownload"));

export const xlsxUIPipeline = {
    downloadXlsxFromCsvLines: async (...args: Parameters<Pipeline["downloadXlsxFromCsvLines"]>) =>
        (await load()).downloadXlsxFromCsvLines(...args),
    downloadXlsxFromCsvText: async (...args: Parameters<Pipeline["downloadXlsxFromCsvText"]>) =>
        (await load()).downloadXlsxFromCsvText(...args),
    downloadXlsxFromHeadersAndData: async (...args: Parameters<Pipeline["downloadXlsxFromHeadersAndData"]>) =>
        (await load()).downloadXlsxFromHeadersAndData(...args),
    downloadXlsxWorkbook: async (...args: Parameters<Pipeline["downloadXlsxWorkbook"]>) =>
        (await load()).downloadXlsxWorkbook(...args),
    uploadXlsxFromHeadersAndData: async <T extends { [key: string]: any }>(input: { headers: XlsxHeader[]; file: File }) =>
        (await load()).uploadXlsxFromHeadersAndData<T>(input),
};
export default xlsxUIPipeline;

export type { XlsxHeader, UploadResponse };
