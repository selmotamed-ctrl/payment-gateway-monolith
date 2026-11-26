import { VIcon } from "vuetify/components";
import { dc } from "@/utils/dc";

const Icon = dc((props: any, _expose, { attrs }) => {
    return () => <VIcon {...attrs} {...props} />;
});

export default Icon;
