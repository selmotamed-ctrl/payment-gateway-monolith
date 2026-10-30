import { dc } from "kt-dc";
import { ref } from "vue";
import { useRouter } from "vue-router";
import {
  VBtn, VCard, VCardText, VCardTitle, VTextField, VAlert, VChip,
} from "vuetify/components";
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
      <VCard color="surface" width={420} class="pa-2">
        <VCardTitle class="text-h5 font-weight-bold">Fake Payment Rails</VCardTitle>
        <VCardText>
          <div class="d-flex align-center mb-4">
            <VChip size="small" variant="tonal" color="info">Single tester portal</VChip>
          </div>
          {error.value ? <VAlert type="error" variant="tonal" class="mb-3">{error.value}</VAlert> : null}
          <VTextField
            label="Username" modelValue={username.value}
            onUpdate:modelValue={(value: string) => { username.value = value; }}
            class="mb-2"
          />
          <VTextField
            label="Password" type="password" modelValue={password.value}
            onUpdate:modelValue={(value: string) => { password.value = value; }}
            onKeydown={(event: KeyboardEvent) => { if (event.key === "Enter") void submit(); }}
          />
          <VBtn block class="mt-4" loading={loading.value} onClick={submit}>Sign in</VBtn>
        </VCardText>
      </VCard>
    </div>
  );
});

export default LoginPage;
