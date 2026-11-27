import { createSlot } from "vue";
import { dc } from "@/utils/dc";
import { useRoute, useRouter } from "vue-router";
import {PgAppBar, PgAppBarTitle, PgButton, PgMain, PgSpacer} from "@pg/ui";
import {ScreenContainer} from "@pg/ui";
import {StatusBadge} from "@pg/ui";
import {PgThemeMenu as ThemeMenu} from "@pg/ui";
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
        <PgAppBar color="surface" flat height={64}>
          <PgAppBarTitle class="pg-portal__title">FAKE PAYMENT RAILS</PgAppBarTitle>
          <div class="d-flex ga-2 align-center">
            {links.map((link) => (
              <PgButton
                key={link.to}
                variant={route.path === link.to ? "flat" : "text"}
                color={route.path === link.to ? "primary" : undefined}
                to={link.to}
              >
                {link.label}
              </PgButton>
            ))}
          </div>
          <PgSpacer />
          <ThemeMenu />
          <StatusBadge
            status={user?.environment ?? "SANDBOX"}
            label={user?.environment ?? "SANDBOX"}
            toneOverride="info"
            showDot={false}
          />
          <PgButton variant="text" onClick={logout}>Logout</PgButton>
        </PgAppBar>
        <PgMain>
          <ScreenContainer>{createSlot("default")}</ScreenContainer>
        </PgMain>
      </div>
    );
  },
  { slots: ["default"] },
);

export default PortalLayout;
