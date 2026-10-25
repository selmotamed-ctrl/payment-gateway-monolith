import { defineComponent, type HTMLAttributes, type ReservedProps } from "vue";

export type ThemedTextProps = HTMLAttributes &
    ReservedProps & {
        disabled?: boolean;
        type?: "default" | "title" | "defaultSemiBold" | "subtitle" | "link";
    };

export const ThemedText = defineComponent<ThemedTextProps>(
    (_, ctx) => {
        return () => {
            const attrs = ctx.attrs;
            const { style, type = "default", ...rest } = attrs as any;

            return (
                <>
                    <span
                        onClick={
                            rest.onClick
                                ? (e) => {
                                      e.preventDefault();
                                      if (rest.disabled) {
                                          return;
                                      }
                                      rest.onClick?.(e as any);
                                  }
                                : undefined
                        }
                        style={[
                            {
                                cursor: rest.onClick ? "pointer" : undefined,
                                ...(type === "default"
                                    ? styles.default
                                    : undefined),
                                ...(type === "title"
                                    ? styles.title
                                    : undefined),
                                ...(type === "defaultSemiBold"
                                    ? styles.defaultSemiBold
                                    : undefined),
                                ...(type === "subtitle"
                                    ? styles.subtitle
                                    : undefined),
                                ...(type === "link" ? styles.link : undefined),
                            },
                            style,
                        ]}
                        {...rest}
                    >
                        {ctx.slots.default?.()}
                    </span>
                </>
            );
        };
    },
    {
        slots: ["default"],
    },
);

const styles = {
    default: {
        fontSize: "16px",
        lineHeight: "24px",
    },
    defaultSemiBold: {
        fontSize: "16px",
        lineHeight: "24px",
        fontWeight: "600",
    },
    title: {
        fontSize: "32px",
        fontWeight: "bold",
        lineHeight: "32px",
    },
    subtitle: {
        fontSize: "20px",
        fontWeight: "bold",
    },
    link: {
        lineHeight: "30px",
        fontSize: "16px",
        color: "#0a7ea4",
    },
};

export default ThemedText;
