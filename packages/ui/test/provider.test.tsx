import { describe, expect, it } from "vitest";
import { dc } from "../src/lib/dc";
import { PgProvider } from "../src/provider/PgProvider";
import { usePgUiConfig } from "../src/lib/config";
import { showToast, clearToasts } from "../src/feedback/toastStore";
import { mount, nextFrame } from "./helpers/render";

const copyText = async () => true;
const navigate = () => undefined;

const Child = dc(
    () => {
        const config = usePgUiConfig();
        return () => (
            <div class="child">
                <span class="copy">{typeof config.copyText === "function" ? "has-copy" : "missing-copy"}</span>
                <span class="nav">{typeof config.navigate === "function" ? "has-nav" : "missing-nav"}</span>
                <span class="page-size">{String(config.defaultPageSize)}</span>
            </div>
        );
    },
    { inheritAttrs: false },
);

const App = dc(
    () => () => (
        <PgProvider config={{ copyText, navigate, defaultPageSize: 50 }}>
            <Child />
        </PgProvider>
    ),
    { inheritAttrs: false },
);

describe("PgProvider", () => {
    it("defaults to English LTR", () => {
        document.documentElement.setAttribute("dir", "rtl");
        const { unmount } = mount(App, {});
        expect(document.documentElement.dir).toBe("ltr");
        expect(document.documentElement.lang).toBe("en");
        unmount();
    });

    it("supplies the host config to deeply nested children", async () => {
        const { el, unmount } = mount(App, {});
        await nextFrame();
        expect(el.querySelector(".copy")?.textContent).toBe("has-copy");
        expect(el.querySelector(".nav")?.textContent).toBe("has-nav");
        expect(el.querySelector(".page-size")?.textContent).toBe("50");
        unmount();
    });

    it("mounts a single toaster stack and renders showToast calls", async () => {
        clearToasts();
        const { unmount } = mount(App, {});
        showToast({ tone: "success", message: "Saved", durationMs: 0 });
        await nextFrame();
        expect(document.body.textContent).toContain("Saved");
        expect(document.querySelectorAll(".pg-toast-stack").length).toBe(1);
        unmount();
    });
});
