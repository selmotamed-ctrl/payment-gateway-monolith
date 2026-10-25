import type { FilterField } from "@/components/FiltersContainer";
import { urlsMap } from "@/constants/urlsMap";
import { accountTypes } from "@/pages/user/core/accounts/types";
import { rules } from "../clientValidationRules";
type F = (key?: string) => FilterField<any, any>;
export const multiAccountTypeFilter: F = (key: string = "accountTypes") => ({
    key: key,
    type: "data-autocomplete",
    multiple: true,
    items: accountTypes,
    itemTitle: (i) => i.text,
    itemValue: (i) => i.value,
    label: "Account Type",
});

export const multiBranchFilter: F = (key: string = "branchesIds") => ({
    key: key,
    type: "api-autocomplete",
    url: urlsMap.branchListAll,
    apiDataExtractor: (data) => {
        return data.branches;
    },
    itemTitle: (i) => i.name,
    itemValue: (i) => i.id,
    label: "Branch",
    multiple: true,
});

export const multiCurrencyFilter: F = (key: string = "currenciesIds") => ({
    key: key,
    type: "api-autocomplete",
    url: urlsMap.currenciesList,
    apiDataExtractor: (data) => {
        return data.currencies;
    },
    itemTitle: (i) => `${i.name} ${i.code || ""}`,
    itemValue(item) {
        return item.id;
    },
    label: "Currency",
    multiple: true,
});

export const emailFilter: F = (key= "email") => {
    return {
        key: key,
        type: "text",
        label: "Email",
        fieldType: "email",
        rules: [rules.email("Email")],
    };
};

export const phoneFilter: F = (key= "phone") => {
    return {
        key: key,
        type: "text",
        label: "Phone",
        fieldType: "phone",
        rules: [rules.phone("Phone")],
    };
};

export const nameFilter: F = (key= "name") => {
    return {
        key: key,
        type: "text",
        label: "Name",
        fieldType: "text",
        rules: [rules.title("Name")],
    };
};
