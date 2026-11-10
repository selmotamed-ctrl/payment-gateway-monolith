import { setLocale } from "@/plugins/localization";
import { dc } from "kt-dc";
import { useLocale, useTheme } from "vuetify";
import { VBtn, VIcon, VList, VListItem, VMenu } from "vuetify/components";
import ThemeMenu from "@/components/ThemeMenu";

const ThemedAndLanguageControls = dc(() => {
    const languageMenu = ref(false);
    const theme = useTheme();
    const local = useLocale();
    const currentTheme = theme.current;

    const handleLanguageChange = (locale: string) => {
        local.current.value = locale;
        setLocale(locale); // Still save to localStorage
        languageMenu.value = false;
    };
    return () => {
        return (
            <>
                <ThemedView
                    style={{
                        display: "flex",
                        flexDirection: "row",
                        width: "100%",
                        justifyContent: "end",
                        gap: "22px",
                        animation: "fadeIn 1s ease-out 0.5s both",
                    }}
                >
                    {/* Language Selector */}
                    <VMenu modelValue={languageMenu.value} onUpdate:modelValue={(v: any) => (languageMenu.value = v)} location="bottom end" offset={8}>
                        {{
                            activator: ({ props }: { props: any }) => (
                                <VBtn
                                    {...props}
                                    icon
                                    size="large"
                                    variant="tonal"
                                    color="primary"
                                    style={{
                                        borderRadius: "50%",
                                        backdropFilter: "blur(10px)",
                                        // color: currentTheme.value.dark ? "#81a1c1" : "#667eea",
                                        transition: "all 0.3s ease",
                                    }}
                                >
                                    <VIcon>mdi-translate</VIcon>
                                </VBtn>
                            ),
                            default: () => (
                                <VList
                                    minWidth={"120px"}
                                    density={"comfortable"}
                                    style={{
                                        padding: "8px",
                                        background: currentTheme.value.dark ? "rgba(30, 30, 30, 0.98)" : "rgba(255, 255, 255, 0.98)",
                                        backdropFilter: "blur(20px)",
                                        borderRadius: "var(--pg-radius-md)",
                                        boxShadow: currentTheme.value.dark ? "0 8px 32px rgba(0, 0, 0, 0.5)" : "0 8px 32px rgba(0, 0, 0, 0.12)",
                                    }}
                                >
                                    <VListItem
                                        onClick={() => handleLanguageChange("en")}
                                        style={{
                                            borderRadius: "12px",
                                            margin: "4px 0",
                                        }}
                                        class="menu-item-hover"
                                    >
                                        <VListItem
                                            title="English"
                                            prependIcon="mdi-alpha-e"
                                            style={{
                                                padding: "12px 16px",
                                            }}
                                        />
                                    </VListItem>
                                    <VListItem
                                        onClick={() => handleLanguageChange("ar")}
                                        style={{
                                            borderRadius: "12px",
                                            margin: "4px 0",
                                        }}
                                        class="menu-item-hover"
                                    >
                                        <VListItem
                                            title="العربية"
                                            prependIcon="mdi-alpha-a"
                                            style={{
                                                padding: "12px 16px",
                                            }}
                                        />
                                    </VListItem>
                                </VList>
                            ),
                        }}
                    </VMenu>

                    {/* Theme mode: System / Light / Dark */}
                    <ThemeMenu />
                </ThemedView>
            </>
        );
    };
});

export default ThemedAndLanguageControls;
