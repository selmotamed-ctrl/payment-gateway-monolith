import { dc } from "kt-dc";
import { RouterView } from "vue-router";
import { VApp } from "vuetify/components";

const App = dc(() => {
  return () => (
    <VApp>
      <RouterView />
    </VApp>
  );
});

export default App;
