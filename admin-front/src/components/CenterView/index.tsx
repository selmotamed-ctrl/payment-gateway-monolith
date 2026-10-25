import { dc } from "kt-dc";
import type { ThemedViewProps } from "../ThemedView";
import { useDefaultPadding } from "@/state/style";

const CenterView = dc<
    ThemedViewProps,
    {
        r: () => HTMLElement | null;
    }
>(
    (p, expose, { attrs, slots }) => {
        const r = ref(null as null | HTMLElement);

        expose({ r: () => r.value });
        const padding = useDefaultPadding();
        return () => {
            const props = attrs as ThemedViewProps;
            if (props.href) {
                return (
                    <a
                        {...props}
                        ref={(_r) => {
                            r.value = _r as any;
                        }}
                        style={[
                            {
                                textDecoration: "none",
                                color: "inherit",
                                display: "flex",
                                flex: 1,
                                alignItems: "center",
                                justifyContent: "center",
                                padding: padding.value,
                                gap: "22px",
                                flexDirection: "column",
                                cursor: props.onClick && !props.disabled ? "pointer" : undefined,
                                transition: props.animated !== false ? "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : undefined,
                            },
                            props.style,
                        ]}
                        class={`${props.onClick && !p.noHoverable ? "hoverable" : ""} ${p.animated !== false ? "themed-view-animated" : ""}`}
                        onClick={
                            props.disabled || !props.onClick
                                ? undefined
                                : (e) => {
                                      e.preventDefault();
                                      props.onClick?.(e);
                                  }
                        }
                    >
                        {slots.default?.()}
                    </a>
                );
            }
            return (
                <div
                    {...props}
                    ref={(_r) => {
                        r.value = _r as any;
                    }}
                    style={[
                        {
                            display: "flex",
                                flex: 1,
                            alignItems: "center",
                            justifyContent: "center",
                            padding: padding.value,
                            gap: "22px",
                            flexDirection: "column",
                            cursor: props.onClick && !p.disabled ? "pointer" : undefined,
                            transition: p.animated !== false ? "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : undefined,
                        },
                        props.style,
                    ]}
                    class={`${props.onClick && !p.noHoverable ? "hoverable" : ""} ${p.animated !== false ? "themed-view-animated" : ""}`}
                    onClick={p.disabled ? undefined : props.onClick}
                >
                    {slots.default?.()}
                </div>
            );
        };
    },
    {
        slots: ["default"],
        props: ["disabled", "animated", "noHoverable"] as any,
    },
);
export default CenterView
