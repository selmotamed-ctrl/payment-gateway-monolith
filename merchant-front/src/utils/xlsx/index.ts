import {
    type UploadResponse,
    downloadXlsxFromCsvLines,
    downloadXlsxFromCsvText,
    downloadXlsxFromHeadersAndData,
    downloadXlsxWorkbook,
    uploadXlsxFromHeadersAndData,
    type XlsxHeader,
} from "./templateDownload";

export const xlsxUIPipeline = {
    downloadXlsxFromCsvLines,
    downloadXlsxFromCsvText,
    downloadXlsxFromHeadersAndData,
    downloadXlsxWorkbook,
    uploadXlsxFromHeadersAndData,
};
export default xlsxUIPipeline;

export { type XlsxHeader, type UploadResponse };
