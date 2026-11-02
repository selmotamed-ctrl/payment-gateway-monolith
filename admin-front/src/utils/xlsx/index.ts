import {
    type UploadResponse,
    downloadXlsxFromCsvLines,
    downloadXlsxFromCsvText,
    downloadXlsxFromHeadersAndData,
    uploadXlsxFromHeadersAndData,
    type XlsxHeader,
} from "./templateDownload";

export const xlsxUIPipeline = {
    downloadXlsxFromCsvLines,
    downloadXlsxFromCsvText,
    downloadXlsxFromHeadersAndData,
    uploadXlsxFromHeadersAndData,
};
export default xlsxUIPipeline;

export { type XlsxHeader, type UploadResponse };
