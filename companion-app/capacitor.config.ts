import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
    appId: "ly.paymentgateway.companion",
    appName: "PG Companion",
    webDir: "dist",
    bundledWebRuntime: false,
    android: {
        allowMixedContent: false,
        captureInput: true,
        webContentsDebuggingEnabled: false,
    },
    server: {
        androidScheme: "https",
        hostname: "localhost",
        cleartext: false,
    },
    plugins: {
        LocalNotifications: {
            smallIcon: "ic_stat_companion",
            iconColor: "#0f6bff",
        },
    },
};

export default config;
