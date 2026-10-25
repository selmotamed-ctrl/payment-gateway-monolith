import { urlsMap } from "@/constants/urlsMap";
import router, { defaultRoute } from "@/router";
import { api } from "@/state/api";
import { setUserState, type User } from "@/state/user";
import { toggleTheme, getTheme, appInfo } from "@/state/app";
import { setLocale, getLocaleName } from "@/plugins/localization";
import { rules } from "@/utils/clientValidationRules";
import { extractApiError, type ApiError } from "@/utils/errors/extractor";
import { dc } from "kt-dc";
import { useDisplay, useLocale, useTheme } from "vuetify";
import { VDivider, VForm, VCard, VCardText, VCardActions, VIcon, VAlert, VBtn, VMenu, VList, VListItem, VListItemTitle } from "vuetify/components";
import Logo from "@/assets/images/logo-with-text-vertical.svg";
import type { UserAuthoritiesMapType } from "@/pages/user/core/users/roles/authorities";

// example screen
const LoginScreen = dc(() => {
    const local = useLocale();
    const { t } = local;

    const valid = ref(false);
    const loading = ref(false);
    const loginType = ref("username" as null | "phone" | "username");

    const phone = ref(null as null | string);
    const phoneLabel = t("Phone");
    const phoneRules = [rules.required(phoneLabel), rules.phone(phoneLabel)];

    const username = ref(null as null | string);
    const usernameLabel = t("Username");
    const usernameRules = [rules.required("Username")];

    const password = ref(null as null | string);
    const passwordLabel = t("Password");
    const passwordRules = [rules.required("Password")];

    const passwordShown = ref(false);
    const formRef = ref(null as null | InstanceType<typeof VForm>);
    const apiError = ref(null as null | ApiError);

    // Theme and language state
    const currentTheme = ref(getTheme());
    const currentLocale = ref(getLocaleName());
    const languageMenu = ref(false);

    const handleThemeToggle = () => {
        toggleTheme();
        currentTheme.value = getTheme();
    };

    const handleLanguageChange = (locale: string) => {
        local.current.value = locale;
        setLocale(locale); // Still save to localStorage
        languageMenu.value = false;
    };

    const submit = async () => {
        if (loading.value) {
            return;
        }
        loading.value = true;
        try {
            const responseData: {
                user: User;
                token: string;
                grantedAuthoritiesMap?: UserAuthoritiesMapType;
            } = (
                await api.post(urlsMap.authLogin, {
                    loginType: loginType.value,
                    phone: phone.value,
                    username: username.value,
                    password: password.value,
                })
            ).data;
            console.log("Login Response", responseData);
            setUserState({
                token: responseData.token,
                userInfo: responseData.user,
                authoritiesMap: responseData.grantedAuthoritiesMap || ({} as any),
            });
            router.push(defaultRoute);
        } catch (error) {
            console.error(error);
            const e = extractApiError(error);
            if (e) {
                apiError.value = e;
            }
        } finally {
            loading.value = false;
        }
    };
    const display = useDisplay();

    return () => {
        const isMobile = display.mobile.value;
        return (
            <>
                {/* Beautiful gradient background */}
                <ThemedView
                    style={{
                        background:
                            currentTheme.value === "dark"
                                ? "linear-gradient(135deg, #1a1a2e 0%, #16213e 25%, #0f3460 50%, #1a1a2e 75%, #16213e 100%)"
                                : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                        gap: "22px",
                        flex: 1,
                        transition: "background 0.5s ease",
                    }}
                >
                    {/* Animated background elements */}
                    <ThemedView
                        style={{
                            position: "absolute",
                            top: "10%",
                            left: "10%",
                            width: "200px",
                            height: "200px",
                            borderRadius: "50%",
                            background: currentTheme.value === "dark" ? "rgba(255, 255, 255, 0.03)" : "rgba(255, 255, 255, 0.1)",
                            animation: "float 6s ease-in-out infinite",
                        }}
                    />
                    <ThemedView
                        style={{
                            position: "absolute",
                            top: "60%",
                            right: "15%",
                            width: "150px",
                            height: "150px",
                            borderRadius: "50%",
                            background: currentTheme.value === "dark" ? "rgba(255, 255, 255, 0.02)" : "rgba(255, 255, 255, 0.08)",
                            animation: "float 8s ease-in-out infinite reverse",
                        }}
                    />
                    <ThemedView
                        style={{
                            position: "absolute",
                            bottom: "20%",
                            left: "20%",
                            width: "100px",
                            height: "100px",
                            borderRadius: "50%",
                            background: currentTheme.value === "dark" ? "rgba(255, 255, 255, 0.015)" : "rgba(255, 255, 255, 0.06)",
                            animation: "float 7s ease-in-out infinite",
                        }}
                    />

                    <ThemedView
                        style={{
                            display: "flex",
                            flexDirection: "row",
                            width: "100%",
                            justifyContent: "end",
                            padding: "22px",
                            gap: "22px",
                            animation: "fadeIn 1s ease-out 0.5s both",
                        }}
                    >
                        {/* Language Selector */}
                        <VMenu v-model={languageMenu.value} location="bottom end" offset={8}>
                            {{
                                activator: ({ props }: { props: any }) => (
                                    <VBtn
                                        {...props}
                                        icon
                                        size="large"
                                        variant="tonal"
                                        color="white"
                                        style={{
                                            borderRadius: "50%",
                                            backdropFilter: "blur(10px)",
                                            // color: currentTheme.value === "dark" ? "#81a1c1" : "#667eea",
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
                                            background: currentTheme.value === "dark" ? "rgba(30, 30, 30, 0.98)" : "rgba(255, 255, 255, 0.98)",
                                            backdropFilter: "blur(20px)",
                                            borderRadius: "16px",
                                            boxShadow:
                                                currentTheme.value === "dark" ? "0 8px 32px rgba(0, 0, 0, 0.5)" : "0 8px 32px rgba(0, 0, 0, 0.12)",
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

                        {/* Theme Toggle */}
                        <VBtn
                            icon
                            size="large"
                            variant="tonal"
                            // @ts-ignore - VBtn onClick type issue
                            onClick={handleThemeToggle}
                            color="white"
                            style={{
                                width: "56px !important",
                                height: "56px !important",
                                borderRadius: "50% !important",
                                backdropFilter: "blur(10px)",
                                // color: currentTheme.value === "dark" ? "#81a1c1" : "#667eea",
                                transition: "all 0.3s ease",
                            }}
                        >
                            <VIcon>{currentTheme.value === "dark" ? "mdi-weather-sunny" : "mdi-weather-night"}</VIcon>
                        </VBtn>
                    </ThemedView>
                    {/* Main login container */}
                    <ThemedView
                        style={{
                            padding: "12px",
                            alignItems: "center",
                        }}
                    >
                        {/* Logo and welcome section */}
                        <ThemedView
                            style={{
                                alignItems: "center",
                                marginBottom: "22px",
                                animation: "fadeInUp 1s ease-out",
                            }}
                        >
                            <ThemedView
                                style={{
                                    flexDirection: isMobile ? "column" : "row",
                                    gap: "12px",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    paddingBottom: "32px",
                                }}
                            >
                                <img
                                    src={Logo}
                                    alt="Sarraf Logo"
                                    style={{
                                        width: "100%",
                                        height: "200px",
                                        filter: "drop-shadow(0 4px 8px rgba(0, 0, 0, 0.2))",
                                    }}
                                />
                                {appInfo.value?.logoFileInUploadsPath && (
                                    <>
                                        <VDivider vertical></VDivider>
                                        <ApiImage
                                            style={{
                                                height: "120px",
                                                width: "120px",
                                            }}
                                            public
                                            uploadsPath={appInfo.value.logoFileInUploadsPath}
                                        ></ApiImage>
                                    </>
                                )}
                            </ThemedView>
                            <ThemedView
                                style={{
                                    fontSize: "32px",
                                    fontWeight: "700",
                                    color: currentTheme.value === "dark" ? "#e0e0e0" : "white",
                                    textAlign: "center",
                                    marginBottom: "8px",
                                    textShadow: currentTheme.value === "dark" ? "0 2px 4px rgba(0, 0, 0, 0.5)" : "0 2px 4px rgba(0, 0, 0, 0.3)",
                                }}
                            >
                                {t("Welcome Back")}
                            </ThemedView>
                            <ThemedView
                                style={{
                                    fontSize: "16px",
                                    color: currentTheme.value === "dark" ? "rgba(224, 224, 224, 0.7)" : "rgba(255, 255, 255, 0.8)",
                                    textAlign: "center",
                                    marginBottom: "20px",
                                }}
                            >
                                {t("Sign in to access your Sarraf account")}
                            </ThemedView>
                        </ThemedView>

                        {/* Login form card */}
                        <Card
                            style={{
                                maxWidth: "450px",
                                width: "100%",
                                borderRadius: "20px",
                                backdropFilter: "blur(20px)",
                                background: currentTheme.value === "dark" ? "rgba(30, 30, 30, 0.85)" : "rgba(255, 255, 255, 0.95)",
                                boxShadow: currentTheme.value === "dark" ? "0 20px 40px rgba(0, 0, 0, 0.3)" : "0 20px 40px rgba(0, 0, 0, 0.1)",
                                border: currentTheme.value === "dark" ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid rgba(255, 255, 255, 0.2)",
                                animation: "fadeInUp 1s ease-out 0.3s both",
                                transition: "all 0.3s ease",
                                padding: "22px 16px",
                            }}
                        >
                            <VForm
                                ref={(r) => {
                                    formRef.value = r as any;
                                }}
                                modelValue={valid.value}
                                onUpdate:modelValue={(v) => {
                                    valid.value = !!v;
                                }}
                                disabled={loading.value}
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    submit();
                                }}
                            >
                                {/* Error alert */}
                                {apiError.value && (
                                    <VAlert
                                        type="error"
                                        style={{
                                            marginBottom: "20px",
                                            borderRadius: "12px",
                                            animation: "slideInFromTop 0.5s ease-out",
                                        }}
                                        closable
                                        onClick:close={() => (apiError.value = null)}
                                    >
                                        {apiError.value.error}
                                    </VAlert>
                                )}

                                {/* Login type selector */}
                                <ThemedView
                                    style={{
                                        marginBottom: "24px",
                                        background: currentTheme.value === "dark" ? "rgba(129, 161, 193, 0.1)" : "rgba(102, 126, 234, 0.1)",
                                        borderRadius: "16px",
                                        padding: "4px",
                                        display: "flex",
                                        flexDirection: "row",
                                        gap: "4px",
                                    }}
                                >
                                    <Button
                                        label="Phone"
                                        variant={loginType.value === "phone" ? "flat" : "text"}
                                        onClick={async () => {
                                            loginType.value = "phone";
                                            await nextTick();
                                            await nextTick();
                                            formRef.value?.validate();
                                        }}
                                        disabled={loading.value}
                                        iconName="mdi-phone"
                                        style={{
                                            flex: 1,
                                            borderRadius: "12px",
                                            backgroundColor:
                                                loginType.value === "phone" ? (currentTheme.value === "dark" ? "#81a1c1" : "#667eea") : "transparent",
                                            color:
                                                loginType.value === "phone"
                                                    ? currentTheme.value === "dark"
                                                        ? "#1e1e1e"
                                                        : "white"
                                                    : currentTheme.value === "dark"
                                                      ? "#81a1c1"
                                                      : "#667eea",
                                            transition: "all 0.3s ease",
                                        }}
                                    />
                                    <Button
                                        label="Username"
                                        variant={loginType.value === "username" ? "flat" : "text"}
                                        onClick={async () => {
                                            loginType.value = "username";
                                            await nextTick();
                                            await nextTick();
                                            formRef.value?.validate();
                                        }}
                                        disabled={loading.value}
                                        iconName="mdi-account"
                                        style={{
                                            flex: 1,
                                            borderRadius: "12px",
                                            backgroundColor:
                                                loginType.value === "username"
                                                    ? currentTheme.value === "dark"
                                                        ? "#81a1c1"
                                                        : "#667eea"
                                                    : "transparent",
                                            color:
                                                loginType.value === "username"
                                                    ? currentTheme.value === "dark"
                                                        ? "#1e1e1e"
                                                        : "white"
                                                    : currentTheme.value === "dark"
                                                      ? "#81a1c1"
                                                      : "#667eea",
                                            transition: "all 0.3s ease",
                                        }}
                                    />
                                </ThemedView>

                                {/* Dynamic input field */}
                                <ThemedView style={{ marginBottom: "20px" }}>
                                    {loginType.value === "phone" && (
                                        <TextField
                                            id="phone"
                                            name="phone"
                                            type="tel"
                                            variant="solo"
                                            class="required-field modern-input"
                                            modelValue={phone.value}
                                            onUpdate:modelValue={(v: string | null) => {
                                                phone.value = v;
                                            }}
                                            label={phoneLabel}
                                            rules={phoneRules}
                                            prependInnerIcon="mdi-phone"
                                            style={{
                                                animation: "slideInFromLeft 0.5s ease-out",
                                            }}
                                        />
                                    )}
                                    {loginType.value === "username" && (
                                        <TextField
                                            id="username"
                                            name="username"
                                            variant="solo"
                                            type="text"
                                            class="required-field modern-input"
                                            modelValue={username.value}
                                            onUpdate:modelValue={(v: string | null) => {
                                                username.value = v;
                                            }}
                                            label={usernameLabel}
                                            rules={usernameRules}
                                            prependInnerIcon="mdi-account"
                                            style={{
                                                animation: "slideInFromLeft 0.5s ease-out",
                                            }}
                                        />
                                    )}
                                </ThemedView>

                                {/* Password field */}
                                <TextField
                                    name="password"
                                    type={passwordShown.value ? "text" : "password"}
                                    variant="solo"
                                    label={passwordLabel}
                                    modelValue={password.value}
                                    onUpdate:modelValue={(v: string | null) => {
                                        password.value = v;
                                    }}
                                    class="required-field modern-input"
                                    rules={passwordRules}
                                    prependInnerIcon="mdi-lock"
                                    appendInnerIcon={passwordShown.value ? "mdi-eye-off" : "mdi-eye"}
                                    onClick:appendInner={() => {
                                        passwordShown.value = !passwordShown.value;
                                    }}
                                    style={{
                                        marginBottom: "32px",
                                        animation: "slideInFromLeft 0.5s ease-out 0.1s both",
                                    }}
                                />

                                {/* Login button */}
                                <Button
                                    label="Sign In"
                                    onClick={() => {
                                        submit();
                                    }}
                                    disabled={loading.value || !valid.value}
                                    loading={loading.value}
                                    iconName="mdi-login"
                                    style={{
                                        width: "100%",
                                        height: "56px",
                                        borderRadius: "16px",
                                        background:
                                            currentTheme.value === "dark"
                                                ? "linear-gradient(135deg, #81a1c1 0%, #5e81ac 100%)"
                                                : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                                        color: currentTheme.value === "dark" ? "#1e1e1e" : "white",
                                        fontSize: "16px",
                                        fontWeight: "600",
                                        boxShadow:
                                            currentTheme.value === "dark"
                                                ? "0 4px 15px rgba(129, 161, 193, 0.4)"
                                                : "0 4px 15px rgba(102, 126, 234, 0.4)",
                                        border: "none",
                                        transition: "all 0.3s ease",
                                        animation: "slideInFromBottom 0.5s ease-out 0.2s both",
                                    }}
                                />
                            </VForm>
                        </Card>

                        {/* Theme and Language Controls */}

                        {/* Footer */}
                        <ThemedView
                            style={{
                                marginTop: "22px",
                                textAlign: "center",
                                color: currentTheme.value === "dark" ? "rgba(224, 224, 224, 0.6)" : "rgba(255, 255, 255, 0.7)",
                                fontSize: "14px",
                                animation: "fadeIn 1s ease-out 0.8s both",
                            }}
                        >
                            <ThemedView style={{ marginBottom: "8px" }}>{t("Secure Currency Exchange Platform")}</ThemedView>
                            <ThemedView>
                                ©{new Date().getFullYear()} {t("Sarraf. All rights reserved.")}
                            </ThemedView>
                        </ThemedView>
                    </ThemedView>
                </ThemedView>

                {/* Custom CSS animations */}
                <style scoped>
                    {`
                        @keyframes float {
                            0%, 100% { transform: translateY(0px); }
                            50% { transform: translateY(-20px); }
                        }

                        @keyframes fadeInUp {
                            from {
                                opacity: 0;
                                transform: translateY(30px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }

                        @keyframes slideInFromTop {
                            from {
                                opacity: 0;
                                transform: translateY(-20px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }

                        @keyframes slideInFromLeft {
                            from {
                                opacity: 0;
                                transform: translateX(-30px);
                            }
                            to {
                                opacity: 1;
                                transform: translateX(0);
                            }
                        }

                        @keyframes slideInFromBottom {
                            from {
                                opacity: 0;
                                transform: translateY(30px);
                            }
                            to {
                                opacity: 1;
                                transform: translateY(0);
                            }
                        }

                        @keyframes fadeIn {
                            from { opacity: 0; }
                            to { opacity: 1; }
                        }

                        .modern-input .v-field {
                            border-radius: 12px !important;
                            background: ${currentTheme.value === "dark" ? "rgba(30, 30, 30, 0.8)" : "rgba(255, 255, 255, 0.8)"} !important;
                            backdrop-filter: blur(10px) !important;
                            border: 1px solid ${currentTheme.value === "dark" ? "rgba(129, 161, 193, 0.2)" : "rgba(102, 126, 234, 0.2)"} !important;
                            transition: all 0.3s ease !important;
                        }

                        .modern-input .v-field:hover {
                            border-color: #667eea !important;
                            box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.1) !important;
                        }

                        .modern-input .v-field--focused {
                            border-color: #667eea !important;
                            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.2) !important;
                        }
                    `}
                </style>
            </>
        );
    };
});

export default LoginScreen;
