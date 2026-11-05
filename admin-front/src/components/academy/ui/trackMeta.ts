import type { BadgeTone } from "@/components/ui/StatusBadge";
import type { TrackId } from "@/content/academy";
import type { BadgeState } from "../useAcademyProgress";

/** One MDI icon per track (a quiet identity marker; never colour-coded). */
export const TRACK_ICON: Record<TrackId, string> = {
    FOUNDATION: "mdi-school-outline",
    OPERATOR: "mdi-headset",
    SUPPORT: "mdi-lifebuoy",
    FINANCE: "mdi-scale-balance",
    COMPLIANCE: "mdi-shield-check-outline",
    MLRO: "mdi-shield-search",
    GATEWAY_ADMIN: "mdi-router-network",
    SECURITY_ADMIN: "mdi-shield-key-outline",
};

export const trackIcon = (id: string): string => TRACK_ICON[id as TrackId] ?? "mdi-school-outline";

/** Badge state -> StatusBadge tone (the single mapping used by every Academy surface). */
export const BADGE_TONE: Record<BadgeState, BadgeTone> = {
    none: "neutral",
    valid: "success",
    expiring: "warning",
    expired: "danger",
    recertify: "danger",
};
