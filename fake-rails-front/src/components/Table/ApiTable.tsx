import { computed, defineComponent, onMounted, onUnmounted, ref, type PropType, type VNodeChild } from "vue";
import { useLocale } from "vuetify";
import { VAlert } from "vuetify/components";
import { api } from "@/utils/api";
import DataTable from "./DataTable";
import type { TableHeader } from "./types";
import type { FilterValues, TableFilter } from "./filters";

export const ApiTable = defineComponent({
  name: "ApiTable",
  props: {
    url: { type: String, required: true },
    title: { type: String, required: true },
    headers: { type: Array as PropType<TableHeader<any>[]>, default: () => [] },
    apiDataExtractor: { type: Function as PropType<(data: any) => any[]>, required: true },
    apiTotalExtractor: { type: Function as PropType<(data: any) => number>, default: undefined },
    onData: { type: Function as PropType<(rows: any[], total: number) => void>, default: undefined },
    numberOfItemsPerPage: { type: Number, default: 10 },
    numberOfItemsPerPageChoices: { type: [Array, Boolean] as PropType<false | { label: string; value: number }[]>, default: undefined },
    setNumberOfItemsPerPage: { type: Function as PropType<(value: number) => void>, default: undefined },
    showNumber: { type: Boolean, default: false },
    searchValue: { type: String as PropType<string | null>, default: undefined },
    setSearchValue: { type: Function as PropType<(value: string | null) => void>, default: undefined },
    filters: { type: Array as PropType<TableFilter[]>, default: () => [] },
    filterValues: { type: Object as PropType<FilterValues>, default: undefined },
    onFilterChange: { type: Function as PropType<(key: string, value: unknown) => void>, default: undefined },
    onFilterClear: { type: Function as PropType<() => void>, default: undefined },
    filterTotal: { type: Number, default: undefined },
    setRefreshHook: { type: Function as PropType<(props: { reset: () => void; refresh: () => void; refreshAsIs: () => void }) => void>, default: undefined },
    clearRefreshHook: { type: Function as PropType<(props: { reset: () => void; refresh: () => void; refreshAsIs: () => void }) => void>, default: undefined },
    TopSlot: { type: Function as PropType<(props: { loading: boolean; reset: () => void; refresh: () => void; refreshAsIs: () => void }) => JSX.Element>, default: undefined },
  },
  setup(props) {
    const { t } = useLocale();
    const rows = ref<any[]>([]);
    const total = ref(0);
    const loading = ref(false);
    const error = ref<string | null>(null);
    const reset = () => void load();

    const load = async () => {
      loading.value = true;
      error.value = null;
      try {
        const payload = await api<any>(props.url);
        const extracted = props.apiDataExtractor(payload);
        rows.value = extracted;
        total.value = props.apiTotalExtractor ? props.apiTotalExtractor(payload) : extracted.length;
        props.onData?.(extracted, total.value);
      } catch (caught) {
        error.value = caught instanceof Error ? caught.message : t("Failed to load");
        rows.value = [];
        total.value = 0;
      } finally {
        loading.value = false;
      }
    };

    const refresh = () => void load();
    const refreshAsIs = () => void load();
    const hooks = computed(() => ({ reset, refresh, refreshAsIs }));

    onMounted(() => {
      props.setRefreshHook?.(hooks.value);
      void load();
    });

    onUnmounted(() => {
      props.clearRefreshHook?.(hooks.value);
    });

    return (): VNodeChild => (
      <>
        {error.value ? (
          <VAlert type="error" variant="tonal" density="compact" class="mb-3">{error.value}</VAlert>
        ) : null}
        <DataTable
          data={rows.value}
          headers={props.headers}
          title={props.title}
          loading={loading.value}
          numberOfItemsPerPage={props.numberOfItemsPerPage}
          numberOfItemsPerPageChoices={props.numberOfItemsPerPageChoices}
          setNumberOfItemsPerPage={props.setNumberOfItemsPerPage}
          showNumber={props.showNumber}
          searchValue={props.searchValue}
          setSearchValue={props.setSearchValue}
          filters={props.filters}
          filterValues={props.filterValues}
          onFilterChange={props.onFilterChange}
          onFilterClear={props.onFilterClear}
          filterTotal={props.filterTotal}
          TopSlot={props.TopSlot ? (slotProps) => props.TopSlot!({ ...slotProps, loading: loading.value }) : undefined}
        />
      </>
    );
  },
});

export default ApiTable;
