import { afterEach } from "vitest";

/**
 * Every component test mounts into its own container. Clean the document so a
 * leaked portal/overlay can never satisfy a later assertion.
 */
afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.setAttribute("dir", "ltr");
    document.documentElement.setAttribute("lang", "en");
    localStorage.clear();
});
