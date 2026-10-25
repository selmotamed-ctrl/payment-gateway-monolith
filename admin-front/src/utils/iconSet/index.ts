import { h } from "vue";
import type { IconProps } from "vuetify";

import institution from "./icons/Institution.vue";
import institutionAdd from "./icons/InstitutionAdd.vue";

const Icons: any = {
    institutionAdd,
    institution,
};

const IconsSet = {
    component: (props: IconProps) => h(Icons[props.icon as any]),
};

export { Icons /* aliases */, IconsSet };
