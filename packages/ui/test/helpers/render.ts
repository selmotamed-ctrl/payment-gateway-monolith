import { createVaporApp } from "vue";
import type { Component } from "vue";

export type Mounted = {
    el: HTMLElement;
    unmount: () => void;
};

/**
 * Mounts a Vapor component into a fresh container. Vapor does not use the
 * virtual DOM, so assertions read the real document.
 */
export const mount = (component: Component, props: Record<string, any> = {}): Mounted => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const app = createVaporApp(component as any, props as any);
    app.mount(el);
    return {
        el,
        unmount: () => {
            try {
                app.unmount();
            } catch {
                /* already unmounted */
            }
            el.remove();
        },
    };
};

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
export const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
