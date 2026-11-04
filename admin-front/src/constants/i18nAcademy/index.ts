import { academy_examCatalogue } from "./exam";
import { academy_labsCatalogue } from "./labs";
import { academy_learnerCatalogue } from "./learner";

/** Merged into the app catalogue by `plugins/i18n.ts`. Each area owns its own file. */
export const academyCatalogue: Record<string, [string, string]> = {
    ...academy_learnerCatalogue,
    ...academy_labsCatalogue,
    ...academy_examCatalogue,
};
