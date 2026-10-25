
import {
    defineComponent as _dc,
    type ComponentOptions,
    type ComponentOptionsMixin,
    type CreateComponentPublicInstanceWithMixins,
    type EmitsOptions,
    type EmitsToProps,
    type PublicProps,
    type RenderFunction,
    type SetupContext,
    type Slot,
    type Slots,
    type SlotsType,
} from "vue";

export type DefineSetupFnComponent<
    P extends Record<string, any>,
    Expose extends Record<string, any>,
    E extends EmitsOptions = {},
    S extends SlotsType = SlotsType,
    Props = P & EmitsToProps<E>,
    PP = PublicProps
> = new (props: Props & PP) => Expose &
    CreateComponentPublicInstanceWithMixins<
        Props,
        {},
        {},
        {},
        {},
        ComponentOptionsMixin,
        ComponentOptionsMixin,
        E,
        PP,
        {},
        false,
        {},
        S
    >;

type Prettify<T> = {
    [K in keyof T]: T[K];
} & {};
export type UnwrapSlotsType<S extends SlotsType, T = NonNullable<S[any]>> = [keyof S] extends [never]
    ? Slots
    : Readonly<
          Prettify<{
              [K in keyof T]: NonNullable<T[K]> extends (...args: any[]) => any ? T[K] : Slot<T[K]>;
          }>
      >;

type E = {};
type EE = string;
type S = {};

export type DCExpose<Expose extends Record<string, any>> = (exposed?: {
    [P in keyof Expose]: Expose[P] | Ref<Expose[P] , Expose[P] >
}) => void;

export const defineComponent = <Props extends Record<string, any>, Expose extends Record<string, any>>(
    setup: (
        props: Props,
        expose: DCExpose<Expose>,
        ctx: SetupContext<E, S>
    ) => RenderFunction | Promise<RenderFunction>,
    options?: Pick<ComponentOptions, "name" | "inheritAttrs"> & {
        props?: (keyof Props)[];
        emits?: E | EE[];
        slots?: S;
    }

): DefineSetupFnComponent<Props, Expose, E, S> =>
    _dc((props, context) => setup(props, context.expose, context), options) as any;

export const dc = defineComponent;
