import {
    type UploadResponse,
    downloadXlsxFromHeadersAndData,
    uploadXlsxFromHeadersAndData,
    type XlsxHeader,
} from "./templateDownload";

export const xlsxUIPipeline = {
    downloadXlsxFromHeadersAndData,
    uploadXlsxFromHeadersAndData,
};
export default xlsxUIPipeline;

export { type XlsxHeader, type UploadResponse };
