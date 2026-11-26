import { dc } from "@/utils/dc";
import { type HTMLAttributes, type ReservedProps, createSlot, ref } from "vue";
import { defineComponent } from "@/utils/dc";
export type ThemedViewProps = HTMLAttributes &
    ReservedProps & {
        disabled?: boolean;
        animated?: boolean;
        noHoverable?: boolean;
        href?: string;
    };
export const ThemedView = dc<
    ThemedViewProps,
    {
        r: ()=>HTMLElement | null;
    }
>(
    (p, expose, { attrs, slots, }) => {
        const r = ref(null as null | HTMLElement);

        expose({ r: ()=> r.value });

        return () => {
            const props = attrs as ThemedViewProps;
            return (props.href ? (
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
                        {createSlot("default")}
                    </a>
                ) : (
                <div
                    {...props}
                    ref={(_r) => {
                        r.value = _r as any;
                    }}
                    style={[
                        {
                            display: "flex",
                            flexDirection: "column",
                            cursor: props.onClick && !p.disabled ? "pointer" : undefined,
                            transition: p.animated !== false ? "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)" : undefined,
                        },
                        props.style,
                    ]}
                    class={`${props.onClick && !p.noHoverable ? "hoverable" : ""} ${p.animated !== false ? "themed-view-animated" : ""}`}
                    onClick={p.disabled ? undefined : props.onClick}
                >
                    {createSlot("default")}
                </div>
            ));
        };
    },
    {
        slots: ["default"],
        props: ["disabled", "animated", "noHoverable"] as any,
    },
);
export default ThemedView;
