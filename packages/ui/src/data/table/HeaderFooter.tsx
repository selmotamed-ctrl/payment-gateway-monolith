import { type IconProps, type RefreshMethodWithNextSkip, type TableHeader as TableHeaderType } from "./types";

const colors = { blue: { base: "var(--pg-accent-brand)" }, grey: { base: "var(--pg-ink-muted)" } } as any;
import { useLocale } from "../../lib/locale";
import { useDisplay } from "../../lib/display";
import { PgButton } from "../../actions/PgButton";
import { PgIcon } from "../../actions/PgIcon";
import { PgMenu } from "../../overlays/PgMenu";
import { PgTextField } from "../../inputs/PgTextField";
import { PgSpinner } from "../../actions/PgFeedbackAtoms";
import { PgSearchInput } from "../../inputs/PgSearchInput";
import { PgAutocomplete } from "../../inputs/PgAutocomplete";
import { PgTooltip } from "../../overlays/PgTooltip";
import { usePgUiConfig } from "../../lib/config";
import { computed, ref, watch } from "vue";
import { defineComponent } from "../../lib/dc";

export const useTableXlsx = (options: {
    headers: () => TableHeaderType<any>[];
    data: () => any[];
    title: () => string;
}) => {
    const config = usePgUiConfig();
    const downloadingXlsx = ref(false);

    const downloadXlsx = async () => {
        const rows = options.data() ?? [];
        if (downloadingXlsx.value || rows.length === 0) return;
        downloadingXlsx.value = true;
        try {
            await config.exportXlsx?.({
                headers: options.headers(),
                data: rows,
                title: options.title(),
            });
        } catch (error) {
            console.error(error);
        } finally {
            downloadingXlsx.value = false;
        }
    };

    return { downloadingXlsx, downloadXlsx };
};

export type TableFilterControl = {
    count: number;
    open: boolean;
    toggle: () => void;
};

export const TableFooter = defineComponent<{
    hasPrev: boolean;
    totalDataLength: number;
    prev: () => void;
    setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
    numberOfItemsPerPageChoices?: { label: string; value: number }[];

    hasNext: boolean;
    numberOfItemsPerPage: number;
    loading: boolean;

    currentPage: number;
    numberOfPages: number;
    goToPage: (targetPageNumber: number) => void;
    next: () => void;
}>(
    (props) => {
        const display = useDisplay();
        const isMobile = computed(() => display.mobile.value);

        return () => {
            return (isMobile.value ? (
                    <TableFooterMobile
                        totalDataLength={props.totalDataLength}
                        loading={props.loading}
                        numberOfItemsPerPage={props.numberOfItemsPerPage}
                        hasNext={props.hasNext}
                        hasPrev={props.hasPrev}
                        next={props.next}
                        prev={props.prev}
                        currentPage={props.currentPage}
                        goToPage={props.goToPage}
                        numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
                        setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
                        numberOfPages={props.numberOfPages}
                    ></TableFooterMobile>
                ) : (
                <TableFooterDesktop
                    numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
                    setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
                    totalDataLength={props.totalDataLength}
                    numberOfItemsPerPage={props.numberOfItemsPerPage}
                    loading={props.loading}
                    hasNext={props.hasNext}
                    hasPrev={props.hasPrev}
                    next={props.next}
                    prev={props.prev}
                    currentPage={props.currentPage}
                    goToPage={props.goToPage}
                    numberOfPages={props.numberOfPages}
                ></TableFooterDesktop>
            ));
        };
    },
    {
        props: [
            "currentPage",
            "goToPage",
            "hasNext",
            "hasPrev",
            "loading",
            "next",
            "numberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "numberOfPages",
            "prev",
            "setNumberOfItemsPerPage",
            "totalDataLength",
        ],
    },
);

type TableHeaderProps = {
    refresh: RefreshMethodWithNextSkip;
    setSearchValue?: (text: string | null) => void;
    searchValue?: string | null;
    onSearch?: () => Promise<void> | void;
    onRefresh?: () => void | Promise<void>;
    iconName?: string;
    xlsx?: {
        handler: () => void | Promise<void>;
        disabled: boolean;
        loading: boolean;
    };
    Icon?: (iconProps: Omit<IconProps, "icon">) => any;
    title: string;
    loading: boolean;
    total?: number;
    filterControl?: TableFilterControl;
};

export const TableHeader = defineComponent<TableHeaderProps>(
    (props) => {
        const display = useDisplay();
        const isMobile = computed(() => display.mobile.value);
        return () => {
            return (isMobile.value ? <TableHeaderMobile {...props}></TableHeaderMobile> : <TableHeaderDesktop {...props}></TableHeaderDesktop>);
        };
    },
    {
        props: [
            "Icon",
            "xlsx",
            "iconName",
            "onSearch",
            "onRefresh",
            "refresh",
            "searchValue",
            "setSearchValue",
            "title",
            "loading",
            "total",
            "filterControl",
        ],
    },
);

const TableHeaderDesktop = defineComponent(
    (props: TableHeaderProps) => {
        return () => (
            <div class="pg-table-toolbar">
                <div class="pg-table-toolbar__left">
                    <HeaderLeft {...props}></HeaderLeft>
                </div>
                <div class="pg-table-toolbar__right">
                    <HeaderRight {...props}></HeaderRight>
                </div>
            </div>
        );
    },
    {
        props: [
            "Icon",
            "xlsx",
            "iconName",
            "onSearch",
            "onRefresh",
            "loading",
            "refresh",
            "searchValue",
            "setSearchValue",
            "title",
            "total",
            "filterControl",
        ],
    },
);

const TableHeaderMobile = defineComponent<TableHeaderProps>(
    (props) => {
        return () => (
            <div class="pg-table-toolbar pg-table-toolbar--mobile">
                <span class="pg-sr-only">{props.title}</span>
                <HeaderLeft {...props}></HeaderLeft>
                <HeaderRight {...props}></HeaderRight>
            </div>
        );
    },
    {
        props: [
            "refresh",
            "xlsx",
            "setSearchValue",
            "searchValue",
            "onSearch",
            "onRefresh",
            "loading",
            "iconName",
            "Icon",
            "title",
            "total",
            "filterControl",
        ],
    },
);

const HeaderLeft = defineComponent<TableHeaderProps>(
    (props) => {
        const { t } = useLocale();
        return () => (
            <div class="pg-table-toolbar__group">
                <span class="pg-sr-only">{t(props.title)}</span>
                {!props.onSearch || !props.setSearchValue ? (
                    <span class="pg-table-toolbar__title">{t(props.title)}</span>
                ) : (
                    <Search {...props}></Search>
                )}
                {props.filterControl && (
                    <PgButton
                        size="small"
                        variant="outlined"
                        prependIcon="mdi-filter-variant"
                        class="pg-filter-trigger"
                        aria-expanded={props.filterControl.open ? "true" : "false"}
                        onClick={() => props.filterControl?.toggle()}
                    >
                        {t("Filters")}
                        {props.filterControl.count > 0 && (
                            <span class="pg-filter-trigger__badge pg-tabular">{props.filterControl.count}</span>
                        )}
                    </PgButton>
                )}
            </div>
        );
    },
    {
        props: [
            "refresh",
            "xlsx",
            "loading",
            "setSearchValue",
            "searchValue",
            "onSearch",
            "onRefresh",
            "iconName",
            "Icon",
            "title",
            "total",
            "filterControl",
        ],
    },
);

const Search = defineComponent<{
    setSearchValue?: (text: string | null) => void;
    searchValue?: string | null;
    refresh: RefreshMethodWithNextSkip;
    onSearch?: () => Promise<void> | void;
    loading: boolean;
}>(
    (props) => {
        const { t } = useLocale();
        return () => (
            <PgSearchInput
                class="pg-table-search"
                modelValue={props.searchValue || ""}
                onUpdate:modelValue={(text: string) => props.setSearchValue?.(text)}
                onSearch={() => props.onSearch?.()}
                disabled={props.loading}
                placeholder={t("Search")}
                ariaLabel={t("Search")}
                debounce={280}
            />
        );
    },
    { props: ["setSearchValue", "loading", "searchValue", "refresh", "onSearch"] },
);

const HeaderRight = defineComponent(
    (props: TableHeaderProps) => {
        const { t } = useLocale();
        return () => (
            <div class="pg-table-toolbar__group pg-table-toolbar__group--end">
                {props.total !== undefined && (
                    <span class="pg-record-count pg-tabular">
                        {props.total} {t("records")}
                    </span>
                )}
                <PgTooltip text={t("Refresh")}>
                    <PgButton
                        icon
                        size="sm"
                        variant="text"
                        ariaLabel={t("Refresh")}
                        disabled={props.loading}
                        onClick={() => {
                            if (props.onRefresh) {
                                void props.onRefresh();
                                return;
                            }
                            void props.refresh({ nextSkip: 0 });
                        }}
                    >
                        <PgIcon icon="mdi-refresh" size={18} />
                    </PgButton>
                </PgTooltip>
                {props.xlsx && (
                    <PgTooltip text={t("Download Current Data as Excel Sheet")}>
                        <PgButton
                            icon
                            size="sm"
                            variant="text"
                            ariaLabel={t("Download Current Data as Excel Sheet")}
                            disabled={props.xlsx!.disabled}
                            loading={props.xlsx!.loading}
                            onClick={() => void props.xlsx!.handler()}
                        >
                            <PgIcon icon="mdi-file-excel-outline" size={18} />
                        </PgButton>
                    </PgTooltip>
                )}
            </div>
        );
    },
    { props: ["refresh", "setSearchValue", "searchValue", "onSearch", "onRefresh", "iconName", "Icon", "loading", "title", "total", "filterControl", "xlsx"] },
);

const PageNumberButton = defineComponent<{
    page: number;
    active?: boolean;
    loading: boolean;
    label?: string;
    goToPage: (targetPageNumber: number) => void;
}>(
    (props) => {
        const activate = () => {
            if (!props.loading) props.goToPage(props.page);
        };
        return () => (
            <div
                class={["pg-page-number", props.active ? "pg-page-number--active" : ""]}
                role="button"
                tabindex={props.loading ? -1 : 0}
                aria-current={props.active ? "page" : undefined}
                aria-label={props.label}
                aria-disabled={props.loading ? "true" : undefined}
                onKeydown={(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activate();
                    }
                }}
                onClick={activate}
            >
                <span>{props.label ?? props.page}</span>
            </div>
        );
    },
    {
        props: ["page", "active", "loading", "label", "goToPage"],
    },
);

const TableFooterLeft = defineComponent(
    (props: {
        totalDataLength: number;
        hasPrev: boolean;
        prev: () => void;
        hasNext: boolean;
        loading: boolean;
        next: () => void;

        currentPage: number;
        numberOfPages: number;
        goToPage: (targetPageNumber: number) => void;
    }) => {
        const display = useDisplay();
        const { t } = useLocale();
        return () => {
            const isMobile = display.mobile.value;

            return (!props.totalDataLength || props.totalDataLength == 0 ? <></> : (
                <div
                    class="pg-pagination"
                    {...{ role: "navigation", "aria-label": t("Pagination") }}
                    style={{ gap: isMobile ? "12px" : "16px" }}
                >
                    <PrevButton loading={props.loading} hasPrev={props.hasPrev} prev={props.prev}></PrevButton>
                    <PagesNumbers
                        loading={props.loading}
                        currentPage={props.currentPage}
                        goToPage={props.goToPage}
                        numberOfPages={props.numberOfPages}
                    ></PagesNumbers>
                    <NextButton loading={props.loading} hasNext={props.hasNext} next={props.next}></NextButton>
                </div>
            ));
        };
    },
    {
        props: ["totalDataLength", "hasPrev", "prev", "hasNext", "loading", "next", "currentPage", "numberOfPages", "goToPage"],
    },
);

const PagesNumbers = defineComponent(
    (props: { currentPage: number; numberOfPages: number; goToPage: (targetPageNumber: number) => void; loading: boolean }) => {
        return () => {
            const rangedLength = 2;
            const startSection =
                props.currentPage > rangedLength + 1 ? (
                    <PageNumberButton
                        page={1}
                        label={`1${props.currentPage - rangedLength - 1 == 1 ? "" : "..."}`}
                        loading={props.loading}
                        goToPage={props.goToPage}
                    />
                ) : null;

            const lastSection =
                props.currentPage < props.numberOfPages - rangedLength ? (
                    <PageNumberButton
                        page={props.numberOfPages}
                        label={`${props.currentPage + rangedLength + 1 == props.numberOfPages ? "" : "..."}${props.numberOfPages}`}
                        loading={props.loading}
                        goToPage={props.goToPage}
                    />
                ) : null;

            const previousPagesNumbers: any[] = [];
            for (let i = props.currentPage - rangedLength > 1 ? props.currentPage - rangedLength : 1; i < props.currentPage; i++) {
                previousPagesNumbers.push(
                    <PageNumberButton key={`${i}`} page={i} loading={props.loading} goToPage={props.goToPage} />,
                );
            }

            const nextPagesNumbers: any[] = [];
            for (let i = props.currentPage + 1; i <= Math.min(props.numberOfPages, props.currentPage + rangedLength); i++) {
                nextPagesNumbers.push(
                    <PageNumberButton key={`${i}`} page={i} loading={props.loading} goToPage={props.goToPage} />,
                );
            }

            return (
                <div class="pg-page-numbers">
                    {startSection}
                    {previousPagesNumbers}
                    <PageNumberButton page={props.currentPage} active loading={props.loading} goToPage={props.goToPage} />
                    {nextPagesNumbers}
                    {lastSection}
                </div>
            );
        };
    },
    {
        props: ["currentPage", "numberOfPages", "goToPage", "loading"],
    },
);

const PrevButton = defineComponent(
    (props: { loading: boolean; hasPrev: boolean; prev: () => void }) => {
        const locale = useLocale();
        return () => {
            const isDisabled = !props.hasPrev || props.loading;
            return (
                <div
                    class={["pg-pagination-button", isDisabled ? "pg-pagination-button--disabled" : ""]}
                    role="button"
                    tabindex={isDisabled ? -1 : 0}
                    {...{ "aria-label": locale.t("Previous page"), "aria-disabled": isDisabled ? "true" : "false" }}
                    onKeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (!isDisabled) props.prev();
                        }
                    }}
                    onClick={() => {
                        if (!isDisabled) props.prev();
                    }}
                >
                    <PgIcon icon={locale.isRtl.value ? "mdi-chevron-right" : "mdi-chevron-left"} size={18} />
                </div>
            );
        };
    },
    {
        props: ["loading", "hasPrev", "prev"],
    },
);

const NextButton = defineComponent(
    (props: { loading: boolean; hasNext: boolean; next: () => void }) => {
        const locale = useLocale();
        return () => {
            const isDisabled = !props.hasNext || props.loading;
            return (
                <div
                    class={["pg-pagination-button", isDisabled ? "pg-pagination-button--disabled" : ""]}
                    role="button"
                    tabindex={isDisabled ? -1 : 0}
                    {...{ "aria-label": locale.t("Next page"), "aria-disabled": isDisabled ? "true" : "false" }}
                    onKeydown={(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            if (!isDisabled) props.next();
                        }
                    }}
                    onClick={() => {
                        if (!isDisabled) props.next();
                    }}
                >
                    <PgIcon icon={locale.isRtl.value ? "mdi-chevron-left" : "mdi-chevron-right"} size={18} />
                </div>
            );
        };
    },
    {
        props: ["loading", "hasNext", "next"],
    },
);

const TableFooterRight = defineComponent(
    (props: {
        dataLength: number;
        numberOfItemsPerPage: number;
        setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
        numberOfItemsPerPageChoices?: { label: string; value: number }[];
    }) => {
        const selectedNumberOfItemsPerPage = ref(
            props.numberOfItemsPerPageChoices?.find((choice) => {
                return choice.value == props.numberOfItemsPerPage;
            }) || (null as null | { label: string; value: number }),
        );

        watch([() => props.numberOfItemsPerPage], () => {
            selectedNumberOfItemsPerPage.value =
                props.numberOfItemsPerPageChoices?.find((choice) => {
                    return choice.value == props.numberOfItemsPerPage;
                }) || null;
        });

        return () => {
            if (!props.dataLength || !props.setNumberOfItemsPerPage || !props.numberOfItemsPerPageChoices) {
                return <></>;
            }
            return (
                <div class="pg-page-size">
                    <PgAutocomplete
                        aria-label="Rows per page"
                        items={props.numberOfItemsPerPageChoices}
                        itemTitle="label"
                        itemValue="value"
                        modelValue={selectedNumberOfItemsPerPage.value?.value ?? props.numberOfItemsPerPage}
                        onUpdate:modelValue={(value: number) => props.setNumberOfItemsPerPage?.(value)}
                        searchable={false}
                        clearable={false}
                        size="sm"
                        density="compact"
                        hideDetails
                    />
                </div>
            );
        };
    },
    {
        props: ["dataLength", "numberOfItemsPerPage", "setNumberOfItemsPerPage", "numberOfItemsPerPageChoices"],
    },
);

const TableFooterMobile = defineComponent(
    (props: {
        totalDataLength: number;
        hasPrev: boolean;
        setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
        numberOfItemsPerPageChoices?: { label: string; value: number }[];
        numberOfItemsPerPage: number;
        prev: () => void;
        hasNext: boolean;
        loading: boolean;
        next: () => void;

        currentPage: number;
        numberOfPages: number;
        goToPage: (targetPageNumber: number) => void;
    }) => {
        return () => (
            <div class="pg-table-footer pg-table-footer--mobile">
                <TableFooterLeft
                    totalDataLength={props.totalDataLength}
                    loading={props.loading}
                    hasNext={props.hasNext}
                    hasPrev={props.hasPrev}
                    next={props.next}
                    currentPage={props.currentPage}
                    goToPage={props.goToPage}
                    numberOfPages={props.numberOfPages}
                    prev={props.prev}
                />
                <TableFooterRight
                    dataLength={props.totalDataLength}
                    numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
                    numberOfItemsPerPage={props.numberOfItemsPerPage}
                    setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
                />
            </div>
        );
    },
    {
        props: [
            "totalDataLength",
            "hasPrev",
            "setNumberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "numberOfItemsPerPage",
            "prev",
            "hasNext",
            "loading",
            "next",
            "currentPage",
            "numberOfPages",
            "goToPage",
        ],
    },
);

const TableFooterDesktop = defineComponent(
    (props: {
        hasPrev: boolean;
        setNumberOfItemsPerPage?: (numberOfItemsPerPage: number) => void;
        numberOfItemsPerPageChoices?: { label: string; value: number }[];
        numberOfItemsPerPage: number;

        prev: () => void;
        totalDataLength: number;

        currentPage: number;
        numberOfPages: number;
        goToPage: (targetPageNumber: number) => void;
        hasNext: boolean;
        next: () => void;
        loading: boolean;
    }) => {
        return () => (
            <div class="pg-table-footer">
                <TableFooterLeft
                    totalDataLength={props.totalDataLength}
                    loading={props.loading}
                    hasNext={props.hasNext}
                    hasPrev={props.hasPrev}
                    next={props.next}
                    prev={props.prev}
                    currentPage={props.currentPage}
                    goToPage={props.goToPage}
                    numberOfPages={props.numberOfPages}
                />
                <TableFooterRight
                    dataLength={props.totalDataLength}
                    numberOfItemsPerPage={props.numberOfItemsPerPage}
                    numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
                    setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
                />
            </div>
        );
    },
    {
        props: [
            "hasPrev",
            "setNumberOfItemsPerPage",
            "numberOfItemsPerPageChoices",
            "numberOfItemsPerPage",
            "prev",
            "totalDataLength",
            "currentPage",
            "numberOfPages",
            "goToPage",
            "hasNext",
            "next",
            "loading",
        ],
    },
);

export const PgTableHeader = TableHeader;
export const PgTableFooter = TableFooter;
