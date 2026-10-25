import { dc } from "kt-dc";

import { ref, onMounted, onBeforeUnmount } from "vue";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import ThemedView from "@/components/ThemedView";
import { VCard, VCardActions, VCardText, VDialog } from "vuetify/components";
import type { RulesList } from "@/utils/clientValidationRules";
import { useDisplay, useLocale } from "vuetify";
export type Cords = {
    latitude: string;
    longitude: String;
};
const CordsInputMap = dc(
    (props: {
        onSet: (props: Cords) => void;
        onClear: () => void;
        value: Cords | null;
        label?: string;
        class?: string;
        rules?: RulesList;
        slot?: () => JSX.Element;
        loading?: boolean;
        disabled?: boolean;
        variant?: "dialog" | "direct";
        fullRounded?: boolean;
        additionalActions?: () => JSX.Element;
    }) => {
        const { t } = useLocale();
        let map: L.Map | null = null;
        let marker = null as null | L.Marker<any>;

        onMounted(() => {});

        onBeforeUnmount(() => {
            if (map) map.remove();
        });

        const isDisabled = computed(() => {
            return !!props.disabled;
        });

        function setMarker(lat: number, lng: number, moveMap = true) {
            if (!map) {
                return;
            }

            const pos: [number, number] = [lat, lng];

            if (!marker) {
                marker = L.marker(pos, { draggable: true }).addTo(map);

                marker.on("dragend", (ev) => {
                    if (!isDisabled.value) {
                        const p = ev.target.getLatLng();
                        const lat = p.lat.toFixed(6);
                        const lng = p.lng.toFixed(6);
                        props.onSet({
                            latitude: lat,
                            longitude: lng,
                        });
                    }
                });
            } else {
                marker.setLatLng(pos);
            }

            if (moveMap) {
                map.flyTo(pos, 13, { animate: true });
            }
        }

        const setMapRef = async (r: HTMLElement | null) => {
            if (r) {
                console.log("Setting map ", r   );
                if (map) {
                    return;
                }
                await nextTick();
                await nextTick();
                await nextTick();
                let initialLat = 32.867097;
                let initialLng = 13.206216;

                if (props.value) {
                    initialLat = Number(props.value.latitude);
                    initialLng = Number(props.value.longitude);
                }

                map = L.map(r, {
                    attributionControl: false,
                }).setView([initialLat, initialLng], 13);
                L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
                    maxZoom: 19,
                    attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                }).addTo(map);

                if (props.value) {
                    setMarker(initialLat, initialLng);
                }

                map.on("click", (e) => {
                    const { lat: lt, lng: ln } = e.latlng;
                    if (!isDisabled.value) {
                        const lat = lt.toFixed(6);
                        const lng = ln.toFixed(6);
                        props.onSet({
                            latitude: lat,
                            longitude: lng,
                        });
                    }
                });
            }
        };

        const shown = ref(false);

        watch(
            () => props.disabled,
            () => {
                if (props.disabled && shown.value) {
                    shown.value = false;
                }
            },
        );

        watch(
            () => props.value,
            async () => {
                if (map && props.value) {
                    setMarker(Number(props.value.latitude), Number(props.value.longitude), false);
                } else if (map && !props.value) {
                    marker?.remove();
                    marker = null;
                }
            },
            {
                immediate: true,
            },
        );

        const display = useDisplay();
        return () => {
            const mobile = display.mobile.value;
            const lat = props.value?.latitude;
            const lng = props.value?.longitude;

            const map = (
                <>
                    <ThemedView
                        style={{
                            gap: "22px",
                            width: "100%",
                            height: "100%",
                        }}
                    >
                        <ThemedView
                            style={{
                                flex: 1,
                            }}
                        >
                            <div
                                ref={(r) => {
                                    setMapRef(r as any);
                                }}
                                style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    borderEndStartRadius: "12px",
                                    borderEndEndRadius: "12px",
                                    borderRadius: props.fullRounded ? "12px" : undefined,
                                    overflow: "hidden",
                                    minHeight: "400px",
                                    height: "100%",
                                    width: "100%",
                                }}
                            />
                        </ThemedView>

                        <ThemedView
                            style={{
                                flex: 0,
                                padding: "12px",
                                gap: "12px",
                                flexDirection: !mobile ? "row" : "column",
                                alignItems: !mobile ? "center" : undefined,
                                justifyContent: "stretch",
                            }}
                        >
                            <TextField rules={props.rules} readonly label={t("Latitude")} disabled={props.disabled} modelValue={lat}></TextField>
                            <TextField rules={props.rules} readonly label={t("Longitude")} disabled={props.disabled} modelValue={lng}></TextField>
                        </ThemedView>
                        {props.slot?.()}
                        <ThemedView
                            style={{
                                gap: "12px",
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "end",
                                padding: "12px",
                            }}
                        >
                            <Button
                                label={"Clear"}
                                variant="text"
                                disabled={props.disabled || (!props.value?.latitude && !props.value?.longitude)}
                                onClick={() => {
                                    props.onClear();
                                }}
                            />
                            {props.variant == "dialog" && (
                                <Button
                                    label={"Close"}
                                    variant="text"
                                    onClick={() => {
                                        shown.value = false;
                                    }}
                                />
                            )}
                            {props.additionalActions?.()}
                        </ThemedView>
                    </ThemedView>
                </>
            );

            if (props.variant == "dialog") {
                return (
                    <>
                        <VDialog
                            modelValue={shown.value}
                            onUpdate:modelValue={(v) => {
                                shown.value = !!v;
                            }}
                            maxWidth={"800px"}
                            height={"80%"}
                        >
                            <VCard title={props.label ? t(props.label) : undefined}>
                                <VCardText class="pa-0">{map}</VCardText>
                            </VCard>
                        </VDialog>

                        <TextField
                            readonly
                            disabled={props.disabled}
                            loading={props.loading}
                            // @ts-ignore
                            onClick={() => {
                                if (!props.disabled) {
                                    shown.value = true;
                                }
                            }}
                            modelValue={lat && lng ? `${lat}, ${lng}` : ""}
                            clearable
                            onClick:clear={() => {
                                if (!props.disabled) {
                                    props.onClear();
                                }
                            }}
                        ></TextField>
                    </>
                );
            } else {
                return map;
            }
        };
    },
    {
        props: ["slot", "fullRounded", "additionalActions", "class", "disabled", "label", "loading", "onClear", "onSet", "rules", "value", "variant"],
    },
);

export default CordsInputMap;
