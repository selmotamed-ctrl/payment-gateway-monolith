import {PgApp, PgProvider} from "@pg/ui";
import { useRouter } from "vue-router";
import { RouterView } from "vue-router/experimental/vapor";
import { dc } from "@/utils/dc";
import { createUiConfig } from "./uiConfig";

const App = dc(() => {
    const router = useRouter();
    const config = createUiConfig(router);
    return () => (
        <PgProvider config={config}>
            <PgApp>
                <RouterView />
            </PgApp>
        </PgProvider>
    );
});

export default App;
