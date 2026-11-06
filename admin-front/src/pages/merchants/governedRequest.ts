import type { AxiosResponse } from "axios";
import { extractApiErrorMessage } from "@/utils/errors/extractor";
import { showSnackBar } from "@/utils/snackBar";
import { errorHintFor, outcomeOfResponse, type MutationOutcome } from "./commerceGovernance";

/** Runs a mutation and classifies the answer: HTTP 202 = submitted for approval, otherwise applied. */
export const runGoverned = async (request: () => Promise<AxiosResponse>): Promise<MutationOutcome> => {
    const response = await request();
    return outcomeOfResponse(response.status, response.data);
};

/** Snackbar for a finished mutation. The messages are English keys translated by the snackbar. */
export const notifyOutcome = (outcome: MutationOutcome, appliedMessage: string): void => {
    if (outcome.kind === "approval") {
        showSnackBar({
            type: "primary",
            message: "Submitted for approval. The change is applied only after an independent checker approves it.",
        });
        return;
    }
    showSnackBar({ type: "success", message: appliedMessage });
};

/** The tailored hint of a known error code, otherwise the server message. */
export const commerceErrorMessage = (error: unknown): string => errorHintFor(error) ?? extractApiErrorMessage(error);

export const reportCommerceError = (error: unknown): string => {
    const message = commerceErrorMessage(error);
    showSnackBar({ type: "error", message });
    return message;
};
