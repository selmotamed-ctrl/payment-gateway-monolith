import { defineVaporComponent } from "vue-jsx";
import { DynamicFragment } from "@vue/runtime-vapor";
import { renderEffect, shallowRef } from "vue";
import type { DefineVaporSetupFnComponent } from "vue";

export type DCExpose<T extends Record<string, any>> = (exposed?: {
    [P in keyof T]: T[P];
}) => void;

export type SetupCtx = {
    attrs: Record<string, any>;
    slots: Record<string, (...args: any[]) => any>;
    emit: (event: string, ...args: any[]) => void;
    expose: (exposed?: Record<string, any>) => void;
};

type VueSetup<P = any> = (props: P, ctx: SetupCtx) => any;
type DcSetup<P = any, E = any> = (props: P, expose: DCExpose<E & Record<string, any>>, ctx: SetupCtx) => any;

type ComponentOptionsLike = {
    name?: string;
    props?: Record<string, any> | string[];
    emits?: string[] | Record<string, any>;
    inheritAttrs?: boolean;
    setup?: (props: any, ctx: SetupCtx) => any;
    rerender?: boolean;
    [key: string]: any;
};

const invokeRender = (render: any): any => (typeof render === "function" ? render() : render);

/**
 * Vapor components normally rely on fine-grained updates. A render function with
 * a top-level reactive early return (e.g. `if (!open.value) return null`) cannot
 * be evaluated once, so those components opt into a DynamicFragment re-render.
 * Everything else stays on the normal Vapor path, where `currentInstance` is set
 * while DOM props are patched.
 */
const wrapRender = (render: any, force: boolean): (() => any) => {
    if (typeof render !== "function" || !force) {
        return () => invokeRender(render);
    }
    return () => {
        const fragment = new DynamicFragment(0);
        const current = shallowRef<any>(undefined);
        // Evaluate the render function inside its own effect so `currentInstance`
        // is set while it builds the block. A `computed` would re-evaluate the
        // render during dependency propagation (walkDirty), where no Vapor
        // instance is active; the block it creates would then be detached from
        // the component tree, losing `provide`/`inject` (and API config,
        // router, i18n) for every child component.
        renderEffect(() => {
            current.value = invokeRender(render);
        });
        // Mounting is a separate effect: DOM insertion and child setup must not
        // become dependencies of the render pass above.
        renderEffect(() => {
            const next = current.value;
            fragment.update(() => next);
        });
        return fragment;
    };
};

const renderSetup = (setup: any, props: any, ctx: any, dcMode: boolean, force: boolean): any => {
    const result = dcMode ? setup(props, ctx.expose, ctx) : setup(props, ctx);
    return typeof result === "function" ? wrapRender(result, force)() : result;
};

/**
 * `props` MUST be forwarded to `defineVaporComponent`: the runtime resolves
 * declared defaults (`copyable: true`, `clearable: true`, …) and removes the
 * declared keys from the fallthrough attrs, so an object prop can never render
 * as `primaryaction="[object Object]"` on a DOM node.
 *
 * `rerender` is the only helper-only option and must never reach the runtime.
 */
const componentOptions = (options: ComponentOptionsLike) => {
    const { rerender: _rerender, setup: _setup, ...rest } = options;
    return { inheritAttrs: true, ...rest } as any;
};

/**
 * Vapor replacement for Vue's `defineComponent` setup signature
 * `(props, ctx)`. App components must be Vapor components; a custom Virtual
 * DOM component inside a Vapor tree is rendered as plain text by interop.
 */
export function defineComponent(options: ComponentOptionsLike): DefineVaporSetupFnComponent<any, any, any, any>;
export function defineComponent<P = any>(
    setup: VueSetup<P>,
    options?: ComponentOptionsLike,
): DefineVaporSetupFnComponent<any, any, any, any>;
export function defineComponent(
    setupOrOptions: VueSetup | ComponentOptionsLike,
    options: ComponentOptionsLike = {},
): DefineVaporSetupFnComponent<any, any, any, any> {
    if (typeof setupOrOptions === "object" && setupOrOptions !== null) {
        const { setup, rerender } = setupOrOptions;
        return defineVaporComponent(
            (props: any, ctx: any) => renderSetup(setup ?? (() => undefined), props, ctx, false, Boolean(rerender)),
            componentOptions(setupOrOptions),
        ) as any;
    }

    return defineVaporComponent(
        (props: any, ctx: any) => renderSetup(setupOrOptions, props, ctx, false, Boolean(options.rerender)),
        componentOptions(options),
    ) as any;
}

/**
 * Vapor replacement for `kt-dc`'s `dc` helper, whose setup signature is
 * `(props, expose, ctx)`.
 */
export const dc: {
    <P = any, E = any>(setup: DcSetup<P, E>, options?: ComponentOptionsLike): any;
    (options: ComponentOptionsLike): any;
} = ((setupOrOptions: DcSetup | ComponentOptionsLike, options: ComponentOptionsLike = {}) => {
    if (typeof setupOrOptions === "object" && setupOrOptions !== null) {
        const { setup, rerender } = setupOrOptions;
        return defineVaporComponent(
            (props: any, ctx: any) => renderSetup(setup ?? (() => undefined), props, ctx, false, Boolean(rerender)),
            componentOptions(setupOrOptions),
        ) as any;
    }

    return defineVaporComponent(
        (props: any, ctx: any) => renderSetup(setupOrOptions, props, ctx, true, Boolean(options.rerender)),
        componentOptions(options),
    ) as any;
}) as any;
