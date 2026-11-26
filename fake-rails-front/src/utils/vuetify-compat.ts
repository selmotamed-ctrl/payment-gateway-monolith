import { inject } from "vue";
import { useDisplay as vuetifyUseDisplay, useLocale, useRtl } from "vuetify";
import type { useTheme as vuetifyUseTheme } from "vuetify";

export { useLocale, useRtl };

/**
 * Vuetify `useDisplay` reads the current Virtual DOM instance for its default
 * name. Passing the name explicitly keeps it usable inside a Vapor component.
 */
export const useDisplay = (
    props: Parameters<typeof vuetifyUseDisplay>[0] = { mobile: null },
    name = "pg",
) => vuetifyUseDisplay(props, name);

/**
 * Vuetify `useTheme` rejects calls made from a Vapor setup because it checks
 * the Virtual DOM current instance. The provider itself is a plain injection,
 * so read it directly.
 */
export const useTheme = (): ReturnType<typeof vuetifyUseTheme> => {
    const theme = inject<ReturnType<typeof vuetifyUseTheme>>(
        Symbol.for("vuetify:theme") as any,
        null as any,
    );
    if (!theme) {
        throw new Error("[Vuetify] Could not find injected theme instance");
    }
    return theme;
};
