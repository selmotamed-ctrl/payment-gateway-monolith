import { defaultNumberOfItemsPerPageChoicesWithAll } from "@/components/Table/types";
import { urlsMap } from "@/constants/urlsMap";
import { t } from "@/plugins/localization";
import { api } from "@/state/api";
import { rules } from "@/utils/clientValidationRules";
import { extractApiError, UnknownError, type ApiError } from "@/utils/errors/extractor";
import { dc } from "kt-dc";
import { ref, computed } from "vue";
import {
    VChip,
    VCard,
    VCardActions,
    VCardText,
    VDialog,
    VForm,
    VTextField,
    VIcon,
    VDivider,
    VRow,
    VCol,
    VContainer,
    VBtn,
    VExpandTransition,
    VTooltip,
} from "vuetify/components";
import { useTheme } from "vuetify";
import Checkbox from "@/components/Checkbox";
import { ThemedText } from "@/components/ThemedText";
import { clip } from "@/utils/common";
import {
    ADMIN_AUTHORITY_GROUPS,
    UserAuthorityDetails,
    type UserAuthoritiesMapType,
    type UserAuthorityDetail,
    type UserAuthorityType,
} from "@/utils/authorities";

// Add custom CSS styles for the authorities picker
const customStyles = `
.authority-group-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.authority-item {
    user-select: none;
}

.authority-item:hover {
    transform: scale(1.02);
}

@media (max-width: 600px) {
    .authority-item {
        minmax(200px, 1fr) !important;
    }
}

@media (max-width: 400px) {
    .authority-item {
        minmax(150px, 1fr) !important;
        font-size: 0.875rem;
    }
}
`;

// Group authorities by functional categories with colors
const authorityGroups:{
    name: string;
    icon: string;
    color: string;
    authorities: UserAuthorityDetail[];
}[] = ADMIN_AUTHORITY_GROUPS.map((group) => ({
    name: group.group,
    icon: group.icon,
    color: "primary",
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

        const theme = useTheme();

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

        const toggleGroup = (groupName: string, props: AuthoritiesPickerProps) => {
            const newExpanded = new Set(expandedGroups.value);
            if (newExpanded.has(groupName)) {
                newExpanded.delete(groupName);
            } else {
                newExpanded.add(groupName);
            }
            expandedGroups.value = newExpanded;
        };

        const toggleGroupAuthorities = (group: (typeof authorityGroups)[0], props: AuthoritiesPickerProps) => {
            const allSelected = group.authorities.every((auth) => props.selectedAuthorities?.[auth.authorityKey]);
            group.authorities.forEach((auth) => {
                if (allSelected) {
                    props.onClearAuthority(auth.authorityKey);
                } else {
                    props.onSetAuthority(auth.authorityKey);
                }
            });
        };

        const toggleAllAuthorities = (props: AuthoritiesPickerProps) => {
            const allSelected = Object.values(props.selectedAuthorities || {}).filter(Boolean).length === UserAuthorityDetails.length;
            UserAuthorityDetails.forEach((auth) => {
                if (allSelected) {
                    props.onClearAuthority(auth.authorityKey);
                } else {
                    props.onSetAuthority(auth.authorityKey);
                }
            });
        };

        const getGroupSelectionCount = (group: (typeof authorityGroups)[0], props: AuthoritiesPickerProps) => {
            return group.authorities.filter((auth) => props.selectedAuthorities?.[auth.authorityKey]).length;
        };

        return () => {
            return (
                <ThemedView
                    style={{
                        gap: "22px",
                        opacity: props.disabled ? "0.5" : "1",
                    }}
                >
                    {/* Custom Styles */}
                    <style scoped>{customStyles}</style>

                    {/* Search Bar */}
                    <VTextField
                        modelValue={searchQuery.value} onUpdate:modelValue={(v: any) => (searchQuery.value = v)}
                        placeholder="Search authorities by name or description..."
                        prepend-inner-icon="mdi-magnify"
                        variant="outlined"
                        disabled={props.disabled}
                        density="compact"
                        class="mb-3"
                        clearable
                        hide-details
                    />

                    {/* Quick Actions */}
                    <ThemedView
                        style={{
                            alignItems: "center",
                            flexDirection: "row",
                            gap: "12px",
                        }}
                    >
                        <div
                            onClick={() => {
                                if (props.disabled) {
                                    return;
                                }
                                toggleAllAuthorities(props);
                            }}
                            style="cursor: pointer;"
                        >
                            <VBtn disabled={props.disabled} size="small" variant="outlined" color="primary">
                                {Object.values(props.selectedAuthorities || {}).filter(Boolean).length === UserAuthorityDetails.length
                                    ? "Clear All"
                                    : "Select All"}
                            </VBtn>
                        </div>
                        <VChip size="small" color="info" variant="flat">
                            {Object.values(props.selectedAuthorities || {}).filter(Boolean).length} / {UserAuthorityDetails.length} selected
                        </VChip>
                    </ThemedView>

                    {/* Authority Groups */}
                    <ThemedView
                        style={{
                            gap: "22px",
                        }}
                    >
                        {filteredGroups.value.map((group) => {
                            const selectedCount = getGroupSelectionCount(group, props);
                            const isExpanded = expandedGroups.value.has(group.name);
                            const allSelected = selectedCount === group.authorities.length;

                            return (
                                <ThemedView
                                    key={group.name}
                                    style={{
                                        borderLeft: `4px solid ${group.color}`,
                                        transition: "all 0.3s ease",
                                    }}
                                    class="authority-group-card"
                                >
                                    {/* Group Header */}
                                    <div
                                        style={{
                                            cursor: props.disabled ? undefined : "pointer",
                                            backgroundColor: theme.current.value.dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
                                        }}
                                        onClick={() => {
                                            if (props.disabled) {
                                                return;
                                            }
                                            toggleGroup(group.name, props);
                                        }}
                                    >
                                        <VCardActions class="pa-3">
                                            <VIcon color={group.color} class="mr-2">
                                                {group.icon}
                                            </VIcon>
                                            <div style="flex: 1; minWidth: 0;">
                                                <div class="text-subtitle-2 font-weight-medium text-truncate">{group.name}</div>
                                                <div class="text-caption text-medium-emphasis">
                                                    {selectedCount}/{group.authorities.length} selected
                                                </div>
                                            </div>

                                            <VChip
                                                size="small"
                                                color={allSelected ? group.color : "default"}
                                                variant={allSelected ? "flat" : "outlined"}
                                                onClick={(e: any) => {
                                                    e.stopPropagation();
                                                    if (props.disabled) {
                                                        return;
                                                    }
                                                    toggleGroupAuthorities(group, props);
                                                }}
                                            >
                                                {allSelected ? "All" : selectedCount}
                                            </VChip>

                                            <VBtn icon variant="text" size="small" class="ml-2">
                                                <VIcon>{isExpanded ? "mdi-chevron-up" : "mdi-chevron-down"}</VIcon>
                                            </VBtn>
                                        </VCardActions>
                                    </div>

                                    {/* Authority Items */}
                                    <VExpandTransition>
                                        <div v-show={isExpanded}>
                                            <VDivider />
                                            <VCardText class="pa-3">
                                                <div
                                                    style={{
                                                        display: "grid",
                                                        gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
                                                        gap: "12px",
                                                    }}
                                                >
                                                    {group.authorities.map((authority) => {
                                                        const isSelected = !!props.selectedAuthorities?.[authority.authorityKey];

                                                        return (
                                                            <div
                                                                key={authority.authorityKey}
                                                                style={{
                                                                    display: "flex",
                                                                    alignItems: "center",
                                                                    padding: "8px 12px",
                                                                    borderRadius: "8px",
                                                                    border: `1px solid ${isSelected ? group.color : "rgba(0,0,0,0.12)"}`,
                                                                    backgroundColor: isSelected ? `${group.color}15` : "transparent",
                                                                    cursor: props.disabled ? undefined : "pointer",
                                                                    transition: "all 0.2s ease",
                                                                    minHeight: "48px",
                                                                }}
                                                                class="authority-item"
                                                                onClick={() => {
                                                                    if (props.disabled) {
                                                                        return;
                                                                    }
                                                                    if (isSelected) {
                                                                        props.onClearAuthority(authority.authorityKey);
                                                                    } else {
                                                                        props.onSetAuthority(authority.authorityKey);
                                                                    }
                                                                }}
                                                                onMouseenter={(e: any) => {
                                                                    const target = e.currentTarget as HTMLElement;
                                                                    target.style.backgroundColor = isSelected ? `${group.color}25` : `${group.color}08`;
                                                                }}
                                                                onMouseleave={(e: any) => {
                                                                    const target = e.currentTarget as HTMLElement;
                                                                    target.style.backgroundColor = isSelected ? `${group.color}15` : "transparent";
                                                                }}
                                                            >
                                                                <div style="flex: 1; minWidth: 0;">
                                                                    <VTooltip location="bottom" activator={"parent"}>
                                                                        <ThemedView>{t(authority.description)}</ThemedView>
                                                                    </VTooltip>
                                                                    <div class="text-body-2 text-truncate font-weight-medium">{t(authority.title)}</div>
                                                                    <div
                                                                        class="text-caption text-medium-emphasis text-truncate"
                                                                        style={{
                                                                            textWrap: "wrap",
                                                                            wordWrap: "normal",
                                                                        }}
                                                                    >
                                                                        <ThemedView>{clip(t(authority.description), 33)}</ThemedView>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </VCardText>
                                        </div>
                                    </VExpandTransition>
                                </ThemedView>
                            );
                        })}
                    </ThemedView>

                    {/* Selected Summary */}
                    <Card>
                        <ThemedView
                            style={{
                                gap: "12px",
                            }}
                        >
                            <ThemedText type="default">
                                {`${t("Summary")}: ${Object.values(props.selectedAuthorities || {}).filter(Boolean).length} ${t("authorities selected")}`}
                            </ThemedText>
                            <ThemedView
                                style={{
                                    flexDirection: "row",
                                    flexWrap: "wrap",
                                    gap: "4px",
                                }}
                            >
                                {Object.entries(props.selectedAuthorities || {})
                                    .filter(([_, selected]) => selected)
                                    .map(([key]) => {
                                        const authority = UserAuthorityDetails.find((a) => a.authorityKey === key);
                                        const group = authorityGroups.find((g) => g.authorities.some((a) => a.authorityKey === key));
                                        return authority ? (
                                            <VChip
                                                key={key}
                                                size="x-small"
                                                color={group?.color}
                                                variant="flat"
                                                closable
                                                onClick={() => {
                                                    if (props.disabled) {
                                                        return;
                                                    }
                                                    props.onClearAuthority(key as UserAuthorityType);
                                                }}
                                            >
                                                {authority.title}
                                            </VChip>
                                        ) : null;
                                    })}
                            </ThemedView>
                        </ThemedView>
                    </Card>
                </ThemedView>
            );
        };
    },
    {
        props: ["disabled", "selectedAuthorities", "onSetAuthority", "onClearAuthority"],
    },
);
export default AuthoritiesPicker;
