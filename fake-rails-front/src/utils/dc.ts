import { defineVaporComponent } from "vue-jsx";
import { DynamicFragment } from "@vue/runtime-vapor";
import { computed, provide, renderEffect } from "vue";
import type { DefineVaporSetupFnComponent } from "vue";

export type DCExpose<T extends Record<string, any>> = (exposed?: {
    [P in keyof T]: T[P];
}) => void;

type SetupCtx = {
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
 * Vapor components normally rely on fine-grained updates. A top-level reactive
 * early return opts into a DynamicFragment re-render (`rerender: true`);
 * everything else stays on the normal Vapor path, where `currentInstance` is
 * set while DOM props are patched.
 */
const wrapRender = (render: any, force = false): (() => any) => {
    if (typeof render !== "function" || !force) return () => invokeRender(render);
    return () => {
        const fragment = new DynamicFragment(0);
        const block = computed(() => invokeRender(render));
        renderEffect(() => {
            const current = block.value;
            fragment.update(() => current);
        });
        return fragment;
    };
};


const renderSetup = (setup: any, props: any, ctx: any, dcMode: boolean, force = false): any => {
    const result = dcMode ? setup(props, ctx.expose, ctx) : setup(props, ctx);
    return typeof result === "function" ? wrapRender(result, force)() : result;
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
        const { setup, rerender, ...rest } = setupOrOptions;
        return defineVaporComponent(
            (props: any, ctx: any) => renderSetup(setup ?? (() => undefined), props, ctx, false, rerender),
            { inheritAttrs: true, ...rest } as any,
        ) as any;
    }

    const { props: _props, rerender, ...rest } = options;
    return defineVaporComponent(
        (props: any, ctx: any) => renderSetup(setupOrOptions, props, ctx, false, rerender),
        { inheritAttrs: true, ...rest } as any,
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
        const { setup, rerender, ...rest } = setupOrOptions;
        return defineVaporComponent(
            (props: any, ctx: any) => renderSetup(setup ?? (() => undefined), props, ctx, false, rerender),
            { inheritAttrs: true, ...rest } as any,
        ) as any;
    }

    const { props: _props, rerender, ...rest } = options;
    return defineVaporComponent(
        (props: any, ctx: any) => renderSetup(setupOrOptions, props, ctx, true, rerender),
        { inheritAttrs: true, ...rest } as any,
    ) as any;
}) as any;
