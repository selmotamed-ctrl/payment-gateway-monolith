import { dc } from "kt-dc";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { VAppBar, VAppBarTitle, VBtn, VChip, VMain, VSpacer, VContainer } from "vuetify/components";
import { clearSession, getUser } from "@/utils/api";

export const PortalLayout = dc(
  (_props, _expose, { slots }) => {
    const route = useRoute();
    const router = useRouter();
    const user = getUser();
    const links = [
      { to: "/dashboard", label: "Command Center" },
      { to: "/transactions", label: "Transactions" },
      { to: "/chaos-matrix", label: "Chaos Matrix" },
      { to: "/statements", label: "Statements" },
    ];
    const logout = () => {
      clearSession();
      void router.push("/login");
    };
    return () => (
      <div class="pg-portal">
        <VAppBar color="surface" flat height={64}>
          <VAppBarTitle class="pg-portal__title">FAKE PAYMENT RAILS</VAppBarTitle>
          <div class="d-flex ga-2 align-center">
            {links.map((link) => (
              <VBtn
                key={link.to}
                variant={route.path === link.to ? "flat" : "text"}
                color={route.path === link.to ? "primary" : undefined}
                to={link.to}
              >
                {link.label}
              </VBtn>
            ))}
          </div>
          <VSpacer />
          <VChip color="success" variant="tonal" class="mr-3">
            {user?.environment ?? "SANDBOX"}
          </VChip>
          <VBtn variant="text" onClick={logout}>Logout</VBtn>
        </VAppBar>
        <VMain>
          <VContainer fluid class="pa-6">{slots.default?.()}</VContainer>
        </VMain>
      </div>
    );
  },
  { slots: ["default"] },
);

export default PortalLayout;
