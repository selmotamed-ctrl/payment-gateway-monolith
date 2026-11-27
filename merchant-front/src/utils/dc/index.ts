/**
 * Portal entry for the shared Vapor component factory.
 *
 * This used to be a copy of `@pg/ui`'s `dc`; the copy stripped `options.props`
 * (so every app-level dialog/drawer received `undefined` for its model and
 * defaults) and drifted from the package. Re-export the single package
 * implementation instead.
 */
export { dc, defineComponent } from "@pg/ui";
export type { DCExpose, SetupCtx } from "@pg/ui";
