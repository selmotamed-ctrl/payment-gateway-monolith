import { dc } from "@/utils/dc";
import {JsonDiffViewer, type JsonPatchOperation} from "@pg/ui";

export type { JsonPatchOperation } from "@pg/ui";

export type JsonPatchDiffProps = {
    operations: JsonPatchOperation[];
    base?: unknown;
};

/** Thin wrapper kept for existing callers: all rendering lives in `JsonDiffViewer`. */
export const JsonPatchDiff = dc(
    (props: JsonPatchDiffProps) => {
        return () => <JsonDiffViewer diff={props.operations ?? []} />;
    },
    {
        props: ["operations", "base"],
    },
);

export default JsonPatchDiff;
