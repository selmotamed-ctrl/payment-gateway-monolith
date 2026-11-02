import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import * as xlsx from "xlsx";
import colors from "vuetify/util/colors";

export type XlsxHeader = {
    text: string;
    required?: boolean;
    key: string;
    rules?: Array<(value: any) => undefined | true | string>;
} & (
    | {
          type: "boolean";
          boolean?: boolean;
      }
    | {
          type: "list";
          list?: Array<string>;
      }
    | {
          type: "number";
      }
    | {
          type: "string";
      }
);


const ensureXlsxTitle = (title: string): string => {
    const trimmed = title.trim() || "export";
    return trimmed.toLowerCase().endsWith(".xlsx") ? trimmed : `${trimmed}.xlsx`;
};

export async function downloadXlsxFromHeadersAndData({
    headers,
    data,
    title,
    color
}: {
    headers: XlsxHeader[];
    data?: any[];
    title: string;
    color: string;
}) {
    const primaryColor = color.slice(1);
    const filename = ensureXlsxTitle(title);

    const wb = new ExcelJS.Workbook();
    const worksheet = wb.addWorksheet("Main Sheet", {
        properties: {
            tabColor: {
                argb: `FF${primaryColor}`,
            },
        },
    });

    worksheet.columns = headers?.map((h) => {
        return {
            key: h.key || h.text,
            header: h.text,
        } satisfies Partial<ExcelJS.Column>;
    });

    const headerRow = worksheet.getRow(1);
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: `FF${primaryColor}` },
    };

    headerRow.font = {
        bold: true,
        color: { argb: "FFFFFFFF" },
    };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    worksheet.eachColumnKey((col) => {
        col.alignment = {
            horizontal: "center",
            vertical: "middle",
        };

        const header = headers.find((h) => h.text == col.header)!;
        if (header.type == "boolean") {
            (worksheet as any).dataValidations.add(
                `${col.letter}2:${col.letter}9999`,
                {
                    type: "list",
                    allowBlank: !!header.required,
                    formulae: ['"نعم,لا"'],
                }
            );
        } else if (header.type == "list" && header.list?.length) {
            (worksheet as any).dataValidations.add(
                `${col.letter}2:${col.letter}9999`,
                {
                    type: "list",
                    allowBlank: !!header.required,
                    formulae: [`"${header.list.join(",")}"`],
                }
            );
        } else if (header.type == "number") {
            (worksheet as any).dataValidations.add(
                `${col.letter}2:${col.letter}9999`,
                {
                    type: "decimal",
                    allowBlank: !!header.required,
                }
            );
        }
    });

    if (data) {
        worksheet.addRows(data);
    }

    worksheet.eachColumnKey((col) => {
        let width = String(col.header ?? "").length + 4;
        col.eachCell({ includeEmpty: true }, (cell) => {
            width = Math.max(width, String(cell.text ?? "").length + 4);
        });
        col.width = Math.min(width, 60);
    });
    const buffer = await wb.xlsx.writeBuffer({
        filename,
    });

    saveAs(
        new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        filename
    );
}

/**
 * Converts the CSV rows used by the older export buttons into the same styled
 * workbook produced by the table XLSX pipeline.
 */
export async function downloadXlsxFromCsvText({
    title,
    csv,
    color = colors.blue.base,
}: {
    title: string;
    csv: string;
    color?: string;
}) {
    const workbook = xlsx.read(csv, { type: "string", raw: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) {
        throw new Error("Unable to build the spreadsheet: the export is empty");
    }
    const matrix = xlsx.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: "",
    });
    const [rawHeaders = [], ...rawRows] = matrix;
    const headers: XlsxHeader[] = rawHeaders.map((text, index) => ({
        key: `column_${index}`,
        text: String(text ?? ""),
        type: "string",
        required: false,
    }));
    const data = rawRows.map((row) => {
        const item: Record<string, unknown> = {};
        for (const [index, header] of headers.entries()) {
            item[header.key] = row[index] ?? "";
        }
        return item;
    });
    await downloadXlsxFromHeadersAndData({ headers, data, title, color });
}

export async function downloadXlsxFromCsvLines({
    title,
    lines,
    color = colors.blue.base,
}: {
    title: string;
    lines: string[];
    color?: string;
}) {
    await downloadXlsxFromCsvText({ title, csv: lines.join("\n"), color });
}

export type UploadResponse<T> = {
    ValidData: (T & {
        index: number;
    })[];
    InvalidData: (T & {
        index: number;
    } & {
        errors: { message: string }[];
    })[];
};

export async function uploadXlsxFromHeadersAndData<
    T extends { [key: string]: any }
>({
    headers,
    file,
}: {
    headers: XlsxHeader[];
    file: File;
}): Promise<UploadResponse<T>> {
    const buffer = await file.arrayBuffer();
    const workbook = xlsx.read(buffer);
    const sheet = workbook.Sheets[workbook.SheetNames[0] as string];

    if (!sheet) {
        throw new Error(
            "invalid excel file: please make sure that the file has at least one sheet"
        );
    }

    const records = xlsx.utils.sheet_to_json<T>(sheet);

    const response: UploadResponse<T> = {
        InvalidData: [],
        ValidData: [],
    };

    for (const [index, record] of Object.entries(records)) {
        const mappedRecord = {} as { [key: string]: any };
        const errors = [] as {
            message: string;
        }[];
        for (const header of headers) {
            const value = record[header.text];
            mappedRecord[header.key] = value;
            if (header.rules) {
                for (const rule of header.rules) {
                    const result = rule(value);
                    if (typeof result == "string") {
                        errors.push({
                            message: result,
                        });
                    }
                }
            }
        }
        if (errors.length) {
            response.InvalidData.push({
                ...(mappedRecord as T),
                errors: errors,
                index: Number(index),
            });
        } else {
            response.ValidData.push({
                ...(mappedRecord as T),
                index: Number(index),
            });
        }
    }
    return response;
}
