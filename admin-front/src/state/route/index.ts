import { ref } from "vue";

export const routeLoading = ref(false);

export type RouteLoadError = {
    path: string;
    message: string;
};

export const routeError = ref<RouteLoadError | null>(null);
