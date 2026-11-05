/** Debug logging that only runs in dev builds; production never dumps DOM/headers/query data. */
export const devLog = (...args: unknown[]): void => {
    if (import.meta.env.DEV) {
        console.log(...args);
    }
};
