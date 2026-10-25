export const isDev = () => {
    return !!import.meta.env.DEV;
};

export const isSendNotFoundTranslations = () => {
    return isDev() && import.meta.env.VITE_SEND_NOT_FOUND_TRANSLATIONS === "YES";
};
