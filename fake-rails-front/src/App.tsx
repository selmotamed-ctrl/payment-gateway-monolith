import { dc } from "@/utils/dc";
import { RouterView } from "vue-router/experimental/vapor";
import { VApp } from "@/components/vael/VuetifyShim";
import { VaelProvider } from "@/components/vael/VaelProvider";

const App = dc(() => {
  return () => (
    <VApp>
      <VaelProvider>
        <RouterView />
      </VaelProvider>
    </VApp>
  );
});

export default App;
