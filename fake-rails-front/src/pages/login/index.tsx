import { dc } from "kt-dc";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { VAlert, VBtn, VTextField } from "vuetify/components";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import ThemeMenu from "@/components/ThemeMenu";
import { api, setToken, setUser, type TesterUser } from "@/utils/api";

const LoginPage = dc(() => {
  const router = useRouter();
  const username = ref("tester_admin");
  const password = ref("");
  const error = ref("");
  const loading = ref(false);

  const submit = async () => {
    loading.value = true;
    error.value = "";
    try {
      const result = await api<{ token: string; user: TesterUser }>("/portal-api/auth/login", {
        method: "POST",
        body: { username: username.value, password: password.value },
      });
      setToken(result.token);
      setUser(result.user);
      const redirect = typeof router.currentRoute.value.query.redirect === "string"
        ? router.currentRoute.value.query.redirect
        : "/dashboard";
      await router.push(redirect);
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : "Login failed";
    } finally {
      loading.value = false;
    }
  };

  return () => (
    <div class="pg-hosted">
      <SurfaceCard
        title="Fake Payment Rails"
        style={{ width: "420px", maxWidth: "96vw" }}
        v-slots={{
          headerActions: () => (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <StatusBadge status="SANDBOX" label="Single tester portal" toneOverride="info" showDot={false} />
              <ThemeMenu />
            </div>
          ),
        }}
      >
        {error.value ? <VAlert type="error" variant="tonal" class="mb-3">{error.value}</VAlert> : null}
        <div class="pg-field-wrapper mb-3">
          <label>Username</label>
          <VTextField
            density="compact"
            variant="outlined"
            hideDetails
            modelValue={username.value}
            onUpdate:modelValue={(value: string) => { username.value = value; }}
          />
        </div>
        <div class="pg-field-wrapper mb-3">
          <label>Password</label>
          <VTextField
            type="password"
            density="compact"
            variant="outlined"
            hideDetails
            modelValue={password.value}
            onUpdate:modelValue={(value: string) => { password.value = value; }}
            onKeydown={(event: KeyboardEvent) => { if (event.key === "Enter") void submit(); }}
          />
        </div>
        <VBtn block loading={loading.value} onClick={submit}>Sign in</VBtn>
      </SurfaceCard>
    </div>
  );
});

export default LoginPage;
