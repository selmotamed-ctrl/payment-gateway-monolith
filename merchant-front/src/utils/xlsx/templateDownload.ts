import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import * as xlsx from "xlsx";

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
        color: { argb: "FFFFFFFF" },
    };

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
        col.width = Number(col.header?.length) + 4;
        col.eachCell((cell) => {
            col.width =
                Number(col?.width) > String(cell.value).length
                    ? col.width
                    : Number((cell.value as string)?.length+4);
        });
    });
    const buffer = await wb.xlsx.writeBuffer({
        filename: title?.toString(),
    });

    saveAs(
        new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        title
    );
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
