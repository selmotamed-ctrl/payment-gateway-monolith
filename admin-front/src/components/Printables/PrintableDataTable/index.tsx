import { Table } from "../../Table/Table";
import {} from "../../Table/types";
import { PrintableThemedView } from "../PrintableThemedView";
import { ThemedText } from "../../ThemedText";
import { TableFooter, TableHeader } from "../../Table/HeaderFooter";
import { useDisplay, useLocale, useTheme, type IconProps } from "vuetify";
import { VDivider, VProgressCircular } from "vuetify/components";
import { computed, defineComponent, ref, watch, type StyleValue } from "vue";
import { defaultBoxShadow } from "@/constants/styling";
import { xlsxUIPipeline, type XlsxHeader } from "@/utils/xlsx";
import { colors } from "@/plugins/vuetify";

type TableHeader<T> = {
    startSeparator?: boolean;
    endSeparator?: boolean;
    Header?: () => JSX.Element; // --
    label?: string; // --
    headerIcon?: string; // --
    HeaderIcon?: (iconProps: Omit<IconProps, "name">) => JSX.Element; // --
    headerTextStyle?: StyleValue; // --
    rowTextStyle?: StyleValue;
    headerCellStyle?: StyleValue; // --
    rowCellStyle?: StyleValue; // --
    key: string; // --
    minWidth?: boolean; // - web only
    value?: ((row: T, index: number) => string) | string | string[]; // --
    Value?: (props: { row: T }) => JSX.Element; // --
};

type BaseTableProps<T> = {
    placeDividers?: boolean;
    noElevation?: boolean;
    rowColor?: (row: T) => string | undefined;
    iconName?: string;
    Icon?: (iconProps: Omit<IconProps, "name">) => JSX.Element;
    showNumber?: boolean;
    tableContainerStyle?: StyleValue; // --
    Row?: (props: { items: T }) => JSX.Element; // --
    headers: TableHeader<T>[]; // --
};
type DataTableProps<T> = BaseTableProps<T> & {
    data: T[];
    title: string;
    TopSlot?: () => JSX.Element;
};
type RefreshMethodData = () => Promise<void>;

export const DataTable = defineComponent(
    <T,>(props: DataTableProps<T>) => {
        const allData = computed(() => props.data);
        const total = ref(props.data.length);
        const data = ref<T[]>([]);

        const refresh: RefreshMethodData = async () => {
            let _data = allData.value;
            const totalLength = _data.length;
            total.value = totalLength;
            data.value = _data;
        };

        const display = useDisplay();
        const isMobile = computed(() => display.mobile.value);

        onMounted(()=>{
            refresh();
        })


        const currentTheme = useTheme();


        return () => {
            const isDark = currentTheme.current.value.dark;
            const colors = currentTheme.current.value.colors;
            if (props.showNumber) {
                if (props.headers[0]?.key != "__no") {
                    props.headers.unshift({
                        value: (_, index) => String(index + 1),
                        key: "__no",
                        label: "No.",
                        minWidth: true,
                    });
                } else {
                    props.headers[0] = {
                        value: (_, index) => String(index + 1),
                        key: "__no",
                        label: "No",
                        minWidth: true,
                    };
                }
            }
            return (
                <>
                    <PrintableThemedView
                        style={{
                            flexDirection: "column",
                            gap: "16px",
                            padding: isMobile.value ? "16px" : "24px",
                            backgroundColor: isDark ? colors.surface : "#ffffff",
                            borderRadius: "12px",
                            boxShadow: props.noElevation ?? true ? undefined : defaultBoxShadow,
                            border: props.noElevation ?? true ? undefined : isDark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid #e2e8f0",
                        }}
                    >
                        {props.TopSlot ? (
                            <PrintableThemedView
                                style={{
                                    gap: "12px",
                                }}
                            >
                                {props.TopSlot()}
                                <VDivider></VDivider>
                            </PrintableThemedView>
                        ) : (
                            <></>
                        )}

                        <TableHeader loading={false} title={props.title} refresh={refresh} iconName={props.iconName}></TableHeader>
                        {data.value.length ? (
                            <>
                                <Table
                                    {...props as any}
                                    skip={0}
                                    pageNumber={1}
                                    data={data.value as T[]}
                                    refresh={refresh}
                                ></Table>
                            </>
                        ) : (
                            <>
                                <PrintableThemedView
                                    id="NoData"
                                    style={{
                                        padding: "60px 40px",
                                        borderRadius: "8px",
                                        borderWidth: "1px",
                                        borderStyle: "solid",
                                        borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "#e2e8f0",
                                        backgroundColor: isDark ? colors["surface-variant"] : "#f8fafc",
                                    }}
                                >
                                    <PrintableThemedView
                                        style={{
                                            alignItems: "center",
                                            justifyContent: "center",
                                            flexDirection: "column",
                                            gap: "12px",
                                        }}
                                    >
                                        <ThemedText
                                            style={{
                                                color: colors["on-surface-variant"],
                                                fontSize: "16px",
                                                fontWeight: "500",
                                            }}
                                        >
                                            No Data Found
                                        </ThemedText>
                                        <ThemedText
                                            style={{
                                                color: colors["on-surface-variant"],
                                                fontSize: "14px",
                                                opacity: 0.7,
                                            }}
                                        >
                                            There are no items to display
                                        </ThemedText>
                                    </PrintableThemedView>
                                </PrintableThemedView>
                            </>
                        )}
                    </PrintableThemedView>
                </>
            );
        };
    },
    {
        props: [
            "Icon",
            "Row",
            "data",
            "headers",
            "iconName",
            "loading",
            "TopSlot",
            "xlsx",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "rowColor",
            "searchValue",
            "setNumberOfItemsPerPage",
            "setSearchValue",
            "placeDividers",
            "showNumber",
            "tableContainerStyle",
            "noElevation",
            "title",
        ] as any[],
    },
);

export default DataTable;
