import { dc } from "kt-dc";
import { useRoute, useRouter } from "vue-router";
import { VAppBar, VAppBarTitle, VBtn, VMain, VSpacer } from "vuetify/components";
import { ScreenContainer } from "@/components/ScreenContainer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import ThemeMenu from "@/components/ThemeMenu";
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
          <ThemeMenu />
          <StatusBadge
            status={user?.environment ?? "SANDBOX"}
            label={user?.environment ?? "SANDBOX"}
            toneOverride="info"
            showDot={false}
          />
          <VBtn variant="text" onClick={logout}>Logout</VBtn>
        </VAppBar>
        <VMain>
          <ScreenContainer>{slots.default?.()}</ScreenContainer>
        </VMain>
      </div>
    );
  },
  { slots: ["default"] },
);

export default PortalLayout;
