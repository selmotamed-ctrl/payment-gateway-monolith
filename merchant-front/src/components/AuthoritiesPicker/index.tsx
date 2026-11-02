import { t } from "@/plugins/localization";
import { dc } from "kt-dc";
import { ref, computed } from "vue";
import { VBtn, VDivider, VExpandTransition, VIcon, VTextField, VTooltip } from "vuetify/components";
import { ThemedText } from "@/components/ThemedText";
import { MetaPill } from "@/components/ui/MetaPill";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { clip } from "@/utils/common";
import {
    ADMIN_AUTHORITY_GROUPS,
    UserAuthorityDetails,
    type UserAuthoritiesMapType,
    type UserAuthorityDetail,
    type UserAuthorityType,
} from "@/utils/authorities";

const authorityGroups: {
    name: string;
    icon: string;
    authorities: UserAuthorityDetail[];
}[] = ADMIN_AUTHORITY_GROUPS.map((group) => ({
    name: group.group,
    icon: group.icon,
    authorities: group.authorities.map((authority) => ({
        authorityKey: authority.authorityKey,
        title: authority.title,
        description: authority.description,
        group: group.group,
    })),
}));

type AuthoritiesPickerProps = {
    selectedAuthorities?: UserAuthoritiesMapType;
    disabled?: boolean;
    onSetAuthority: (a: UserAuthorityType) => void;
    onClearAuthority: (a: UserAuthorityType) => void;
};

const AuthoritiesPicker = dc(
    (props: AuthoritiesPickerProps) => {
        const searchQuery = ref("");
        const expandedGroups = ref<Set<string>>(new Set());

        const filteredGroups = computed(() => {
            if (!searchQuery.value) return authorityGroups;

            return authorityGroups
                .map((group) => ({
                    ...group,
                    authorities: group.authorities.filter(
                        (authority) =>
                            authority.title.toLowerCase().includes(searchQuery.value.toLowerCase()) ||
                            authority.description.toLowerCase().includes(searchQuery.value.toLowerCase()),
                    ),
                }))
                .filter((group) => group.authorities.length > 0);
        });

        const toggleGroup = (groupName: string) => {
            const newExpanded = new Set(expandedGroups.value);
            if (newExpanded.has(groupName)) {
                newExpanded.delete(groupName);
            } else {
                newExpanded.add(groupName);
            }
            expandedGroups.value = newExpanded;
        };

        const toggleGroupAuthorities = (group: (typeof authorityGroups)[0]) => {
            const allSelected = group.authorities.every((auth) => props.selectedAuthorities?.[auth.authorityKey]);
            group.authorities.forEach((auth) => {
                if (allSelected) {
                    props.onClearAuthority(auth.authorityKey);
                } else {
                    props.onSetAuthority(auth.authorityKey);
                }
            });
        };

        const toggleAllAuthorities = () => {
            const allSelected = Object.values(props.selectedAuthorities || {}).filter(Boolean).length === UserAuthorityDetails.length;
            UserAuthorityDetails.forEach((auth) => {
                if (allSelected) {
                    props.onClearAuthority(auth.authorityKey);
                } else {
                    props.onSetAuthority(auth.authorityKey);
                }
            });
        };

        const getGroupSelectionCount = (group: (typeof authorityGroups)[0]) => {
            return group.authorities.filter((auth) => props.selectedAuthorities?.[auth.authorityKey]).length;
        };

        return () => {
            const selectedCount = Object.values(props.selectedAuthorities || {}).filter(Boolean).length;
            return (
                <div
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "18px",
                        opacity: props.disabled ? 0.5 : 1,
                    }}
                >
                    <VTextField
                        modelValue={searchQuery.value}
                        onUpdate:modelValue={(value: string | null) => (searchQuery.value = value ?? "")}
                        placeholder="Search authorities by name or description..."
                        prependInnerIcon="mdi-magnify"
                        variant="outlined"
                        disabled={props.disabled}
                        density="compact"
                        clearable
                        hideDetails
                    />

                    <div style={{ display: "flex", alignItems: "center", flexDirection: "row", gap: "8px", flexWrap: "wrap" }}>
                        <VBtn
                            disabled={props.disabled}
                            size="small"
                            variant="outlined"
                            color="primary"
                            onClick={toggleAllAuthorities}
                        >
                            {selectedCount === UserAuthorityDetails.length ? "Clear All" : "Select All"}
                        </VBtn>
                        <MetaPill>
                            {`${selectedCount} / ${UserAuthorityDetails.length} selected`}
                        </MetaPill>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {filteredGroups.value.map((group) => {
                            const groupSelected = getGroupSelectionCount(group);
                            const isExpanded = expandedGroups.value.has(group.name);
                            const allSelected = groupSelected === group.authorities.length;

                            return (
                                <SurfaceCard key={group.name}>
                                    <div
                                        role="button"
                                        tabindex={0}
                                        aria-expanded={isExpanded}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "10px",
                                            cursor: props.disabled ? undefined : "pointer",
                                            minWidth: 0,
                                        }}
                                        onClick={() => {
                                            if (!props.disabled) toggleGroup(group.name);
                                        }}
                                        onKeydown={(event: KeyboardEvent) => {
                                            if (event.target !== event.currentTarget) return;
                                            if (!props.disabled && (event.key === "Enter" || event.key === " ")) {
                                                event.preventDefault();
                                                toggleGroup(group.name);
                                            }
                                        }}
                                    >
                                        <VIcon icon={group.icon} size={18} color="primary" />
                                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                                            <div
                                                style={{
                                                    fontSize: "13.5px",
                                                    fontWeight: 600,
                                                    color: "var(--pg-ink-primary)",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                }}
                                            >
                                                {group.name}
                                            </div>
                                            <div style={{ fontSize: "11.5px", color: "var(--pg-ink-muted)" }}>
                                                {groupSelected}/{group.authorities.length} selected
                                            </div>
                                        </div>
                                        <MetaPill
                                            color={allSelected ? "success" : undefined}
                                            variant={allSelected ? "flat" : "outlined"}
                                            onClick={(event: MouseEvent) => {
                                                event.stopPropagation();
                                                if (!props.disabled) toggleGroupAuthorities(group);
                                            }}
                                            style={{ cursor: props.disabled ? undefined : "pointer" }}
                                        >
                                            {allSelected ? "All" : String(groupSelected)}
                                        </MetaPill>
                                        <VBtn
                                            icon
                                            variant="text"
                                            size="small"
                                            aria-label={isExpanded ? t("Collapse") : t("Expand")}
                                            onClick={(event: MouseEvent) => {
                                                event.stopPropagation();
                                                if (!props.disabled) toggleGroup(group.name);
                                            }}
                                        >
                                            <VIcon>{isExpanded ? "mdi-chevron-up" : "mdi-chevron-down"}</VIcon>
                                        </VBtn>
                                    </div>

                                    <VExpandTransition>
                                        <div v-show={isExpanded}>
                                            <VDivider style={{ margin: "12px 0", borderColor: "var(--pg-border-subtle)" }} />
                                            <div
                                                style={{
                                                    display: "grid",
                                                    gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
                                                    gap: "8px",
                                                }}
                                            >
                                                {group.authorities.map((authority) => {
                                                    const isSelected = !!props.selectedAuthorities?.[authority.authorityKey];

                                                    return (
                                                        <button
                                                            key={authority.authorityKey}
                                                            type="button"
                                                            disabled={props.disabled}
                                                            onClick={() => {
                                                                if (isSelected) {
                                                                    props.onClearAuthority(authority.authorityKey);
                                                                } else {
                                                                    props.onSetAuthority(authority.authorityKey);
                                                                }
                                                            }}
                                                            style={{
                                                                display: "flex",
                                                                alignItems: "center",
                                                                textAlign: "start",
                                                                padding: "8px 12px",
                                                                borderRadius: "var(--pg-radius-sm)",
                                                                border: `1px solid ${isSelected ? "var(--pg-accent-interactive)" : "var(--pg-border-subtle)"}`,
                                                                backgroundColor: isSelected ? "var(--pg-accent-interactive-soft)" : "var(--pg-bg-surface)",
                                                                cursor: props.disabled ? undefined : "pointer",
                                                                transition: "background-color 0.12s ease, border-color 0.12s ease",
                                                                minHeight: "48px",
                                                                font: "inherit",
                                                                color: "inherit",
                                                            }}
                                                        >
                                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                                <VTooltip location="bottom" activator={"parent"}>
                                                                    <ThemedText>{t(authority.description)}</ThemedText>
                                                                </VTooltip>
                                                                <div
                                                                    style={{
                                                                        fontSize: "13px",
                                                                        fontWeight: 500,
                                                                        color: "var(--pg-ink-primary)",
                                                                        overflow: "hidden",
                                                                        textOverflow: "ellipsis",
                                                                        whiteSpace: "nowrap",
                                                                    }}
                                                                >
                                                                    {t(authority.title)}
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        fontSize: "11.5px",
                                                                        color: "var(--pg-ink-muted)",
                                                                        lineHeight: 1.4,
                                                                        overflowWrap: "anywhere",
                                                                    }}
                                                                >
                                                                    {clip(t(authority.description), 33)}
                                                                </div>
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </VExpandTransition>
                                </SurfaceCard>
                            );
                        })}
                    </div>

                    <SurfaceCard title={t("Summary")}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                            <ThemedText type="default">
                                {`${t("Summary")}: ${selectedCount} ${t("authorities selected")}`}
                            </ThemedText>
                            <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "4px" }}>
                                {Object.entries(props.selectedAuthorities || {})
                                    .filter(([, selected]) => selected)
                                    .map(([key]) => {
                                        const authority = UserAuthorityDetails.find((a) => a.authorityKey === key);
                                        return authority ? (
                                            <MetaPill key={key} size="x-small">
                                                <span>{t(authority.title)}</span>
                                                <button
                                                    type="button"
                                                    class="pg-filter-chip__remove"
                                                    aria-label={`${t("Remove")} ${t(authority.title)}`}
                                                    onClick={() => {
                                                        if (!props.disabled) {
                                                            props.onClearAuthority(key as UserAuthorityType);
                                                        }
                                                    }}
                                                >
                                                    <VIcon size={12} icon="mdi-close" />
                                                </button>
                                            </MetaPill>
                                        ) : null;
                                    })}
                            </div>
                        </div>
                    </SurfaceCard>
                </div>
            );
        };
    },
    {
        props: ["disabled", "selectedAuthorities", "onSetAuthority", "onClearAuthority"],
    },
);

export default AuthoritiesPicker;
