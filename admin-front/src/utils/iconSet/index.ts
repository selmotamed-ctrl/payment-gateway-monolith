import { h } from "vue";
import type { IconProps } from "@/utils/vael-compat";

import institution from "./icons/Institution";
import institutionAdd from "./icons/InstitutionAdd";

const Icons: any = {
    institutionAdd,
    institution,
};

const IconsSet = {
    component: (props: IconProps) => h(Icons[props.icon as any]),
};

export { Icons /* aliases */, IconsSet };
