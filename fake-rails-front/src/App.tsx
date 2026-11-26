import { dc } from "@/utils/dc";
import { RouterView } from "vue-router/experimental/vapor";
import { VApp } from "vuetify/components";

const App = dc(() => {
  return () => (
    <VApp>
      <RouterView />
    </VApp>
  );
});

export default App;
