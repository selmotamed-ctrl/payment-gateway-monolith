import { dc } from "@/utils/dc";

/** Renders a function prop that returns a Vapor block. */
export const RenderProp = dc((props: { content?: () => any }) => {
    return () => props.content?.();
});

export default RenderProp;
