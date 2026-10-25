import type { TableHeader } from "@/components/Table/types";
import type { XlsxHeader } from "./templateDownload";
import { t } from "@/plugins/localization";
import xlsxUIPipeline from ".";
import { colors } from "@/plugins/vuetify";
import { recursiveSelect } from "kt-common";

export const downloadTableData = async (props: { title: string; data: any[]; headers: TableHeader<any>[] }) => {
    const translatedHeaders = translateTableHeadersToXlsxHeader(props.headers);
    await xlsxUIPipeline.downloadXlsxFromHeadersAndData({
        color: colors.blue.base,
        headers: translatedHeaders,
        title: props.title,
        data: props.data.map((d, index) => {
            const item = {} as {
                [key: string]: any;
            };
            for (const header of translatedHeaders) {
                console.log("header key", header.key)
                item[header.key] =
                    typeof header.originalHeader.value == "function"
                        ? header.originalHeader.value?.(d, index)
                        : recursiveSelect(header.originalHeader.value || "", d);
            }
            console.log("translated item", item)
            return item;
        }),
    });
};

export const translateTableHeadersToXlsxHeader = (
    headers: TableHeader<any>[],
): (XlsxHeader & {
    originalHeader: TableHeader<any>;
})[] => {
    const translatedHeaders: (XlsxHeader & {
        originalHeader: TableHeader<any>;
    })[] = [];
    for (const th of headers) {
        if (!th.value) {
            console.log("skipping header", th);
            continue;
        }
        translatedHeaders.push({
            key: th.key,
            text: typeof th.label == "string" ? t(th.label) : th.key,
            type: "string",
            required: false,
            originalHeader: th,
        });
    }

    return translatedHeaders;
};
