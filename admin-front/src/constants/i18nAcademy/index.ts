import { academy_examCatalogue } from "./exam";
import { academy_examV2Catalogue } from "./examV2";
import { academy_homeCatalogue } from "./home";
import { academy_labV2Catalogue } from "./lab";
import { academy_labsCatalogue } from "./labs";
import { academy_learnerCatalogue } from "./learner";
import { academy_lessonCatalogue } from "./lesson";
import { academy_teamCatalogue } from "./team";
import { academy_uiCatalogue } from "./ui";

/** Merged into the app catalogue by `plugins/i18n.ts`. Each area owns its own file. */
export const academyCatalogue: Record<string, [string, string]> = {
    ...academy_learnerCatalogue,
    ...academy_labsCatalogue,
    ...academy_examCatalogue,
    ...academy_uiCatalogue,
    ...academy_homeCatalogue,
    ...academy_lessonCatalogue,
    ...academy_labV2Catalogue,
    ...academy_examV2Catalogue,
    ...academy_teamCatalogue,
};
