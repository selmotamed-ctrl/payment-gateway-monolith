import { dc, type DCExpose } from "kt-dc";
import { render } from "vue";
import { useTheme } from "vuetify";

export const printProvider = ref(null as null | InstanceType<typeof PrintProvider>);
export const PrintProvider = dc(
    (
        _,
        expose: DCExpose<{
            setPrintTarget: (target: null | JSX.Element) => void;
            getPrintTargetRef: () => Promise<Element | globalThis.ComponentPublicInstance>;
        }>,
    ) => {
        const el = ref(null as null | JSX.Element);
        let getPrintTargetPromise = null as null | {
            resolve: (result: Element | globalThis.ComponentPublicInstance) => void;
            reject: (err: any) => void;
            timer: ReturnType<typeof setTimeout>;
            resolved: boolean;
        };

        expose({
            setPrintTarget(target) {
                el.value = target;
            },
            getPrintTargetRef() {
                console.log("getting reference of mounted print target on print provider");
                return new Promise<Element | globalThis.ComponentPublicInstance>((resolve, reject) => {
                    getPrintTargetPromise = {
                        resolve,
                        reject,
                        resolved: false,
                        timer: setTimeout(() => {
                            console.log("Timeout Failed to get ref", "providing old ref if available");
                            if (getPrintTargetPromise) {
                                if (oldRef.value) {
                                    resolve(oldRef.value);
                                } else {
                                    reject("Timeout Failed to get ref");
                                }
                                getPrintTargetPromise.resolved = true;
                            }
                        }, 1e3),
                    };
                });
            },
        });
        const oldRef = ref(null as null | HTMLElement);
        const theme = useTheme();
        return () => {
            return (
                <>
                    <div
                        style={{
                            display: "none",
                        }}
                        ref={(r) => {
                            if (!!r && getPrintTargetPromise && !getPrintTargetPromise.resolved) {
                                console.log("Print Target Wrapper provided ref", r, getPrintTargetPromise);
                                getPrintTargetPromise.resolve(r);
                                clearTimeout(getPrintTargetPromise.timer);
                                getPrintTargetPromise = null;
                                oldRef.value = r as any;
                            } else if (!!r) {
                                oldRef.value = r as any;
                            }
                        }}
                    >
                        <ThemedView
                            style={{
                                width: "100%",
                                fontFamily: "Cairo !important",
                                direction: "rtl",
                            }}
                        >
                            {el.value}
                        </ThemedView>
                    </div>
                </>
            );
        };
    },
);

async function printElement(element: Element) {
    // Clone node to avoid moving original DOM
    const cloned = element.cloneNode(true) as Element;
    console.log("Cloned Element for print", cloned);
    // Create hidden iframe
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(iframe);

    const iframeDoc = iframe.contentDocument!;
    const iframeWin = iframe.contentWindow!;

    // Build a minimal document: clone link/style tags so CSS applies
    // Clone <link rel="stylesheet"> and <style> tags from the main document head
    const head = iframeDoc.head;

    // Clone <base> if exists (helps with relative URLs)
    const base = document.head.querySelector("base");
    if (base) head.appendChild(base.cloneNode(true));

    // Clone stylesheets and inline styles
    const links = Array.from(document.querySelectorAll("link[rel='stylesheet']"));
    links.forEach((l) => {
        try {
            head.appendChild(l.cloneNode(true));
        } catch {
            // ignore cross-origin weirdness
        }
    });

    const styles = Array.from(document.querySelectorAll("style"));
    styles.forEach((s) => head.appendChild(s.cloneNode(true)));

    // Append cloned node to iframe body
    iframeDoc.body.appendChild(cloned);

    // Wait a short time to allow CSS, fonts, images to load inside iframe
    // Use fonts.ready where supported to wait for webfonts
    try {
        // @ts-ignore fonts may not exist on old browsers but this is fine
        if (iframeDoc.fonts && iframeDoc.fonts.ready) {
            await iframeDoc.fonts.ready;
        } else {
            await new Promise((r) => setTimeout(r, 200));
        }
    } catch {
        await new Promise((r) => setTimeout(r, 250));
    }

    // Focus and print (some browsers require focus)
    iframeWin.focus();
    // call print and wait a tiny moment — calling directly may sometimes be blocked if not user gesture
    try {
        iframeWin.print();
    } catch (err) {
        console.error("Print failed:", err);
        // fallback: try opening a new window method or notify user
        throw err;
    } finally {
        // cleanup after a short delay to let printing start (don't rely on print callback)
        setTimeout(() => {
            // remove iframe
            try {
                document.body.removeChild(iframe);
            } catch {
                /* ignore */
            }
        }, 1000);
    }
}

function getDomFromRefOrInstance(ref: Element | ComponentPublicInstance): Element {
    // If it's a Vue component instance, prefer $el. Otherwise assume DOM Element.
    // Some component instances might have no $el (edge cases) so fallback to the passed value.
    const maybeInstance = ref as ComponentPublicInstance & { $el?: Element };
    if (maybeInstance && (maybeInstance.$el as Element)) return maybeInstance.$el as Element;
    return ref as Element;
}
export const printTsx = async (element: JSX.Element) => {
    await nextTick();
    if (!printProvider.value) {
        throw new Error("There is no print provider mounted");
    }

    console.log("Mounting print target", element);
    printProvider.value.setPrintTarget(element);
    console.log("Retrieving print target mount ref...");
    const reference = await printProvider.value.getPrintTargetRef();
    console.log("Retrieved print target mount ref", reference);

    const dom = getDomFromRefOrInstance(reference as any);
    if (!dom) throw new Error("Failed to resolve DOM element for printing");
    console.log("Extracted element from reference", dom);
    // Print it
    await printElement(dom.firstElementChild || dom);

    // Optionally clear provider target
    printProvider.value.setPrintTarget(null);
};
