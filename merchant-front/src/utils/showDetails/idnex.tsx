import { DetailsFieldsDialog } from "@/components/detailsFieldsDialog";
import type { FieldProps } from "@/components/Field";

export const detailsDialogRef = ref(null as null | InstanceType<typeof DetailsFieldsDialog>);

export const showDetails = (props: {
    title: string;
    sections?: {
        fields: FieldProps[];
    }[];
    slot?: (props: {
        close: ()=>void;
    }) => JSX.Element;
}) => {
    if (!detailsDialogRef.value) {
        console.error("There is no details dialog reference ");
    }

    detailsDialogRef.value?.show({
        ...props,
    });
};
