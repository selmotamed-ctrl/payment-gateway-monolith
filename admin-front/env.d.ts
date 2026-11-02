/// <reference types="vite/client" />
/// <reference types="vite-plugin-vue-layouts-next/client" />

interface String {
    /**
     * Replace all instances of a substring in a string, using a regular expression or search string.
     * @param searchValue A string to search for.
     * @param replaceValue A string containing the text to replace for every successful match of searchValue in this string.
     */
    replaceAll(searchValue: string | RegExp, replaceValue: string): string;

    /**
     * Replace all instances of a substring in a string, using a regular expression or search string.
     * @param searchValue A string to search for.
     * @param replacer A function that returns the replacement text.
     */
    replaceAll(
        searchValue: string | RegExp,
        replacer: (substring: string, ...args: any[]) => string,
    ): string;
}

interface ImportMetaEnv {
    readonly VITE_SEND_NOT_FOUND_TRANSLATIONS?: string;
    readonly VITE_SHOW_CHECKLISTS?: string;
    readonly VITE_SHOW_SNAPSHOT_EXPORT_CHECKLIST?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

interface Window {
    __PG_RUNTIME_CONFIG__?: {
        showChecklists?: boolean;
        showSnapshotExportChecklist?: boolean;
    };
    $confirmDialog: {
        show: (opts: ConfirmOptions) => Promise<boolean>;
    };
}
