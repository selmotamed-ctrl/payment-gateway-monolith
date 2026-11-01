import "vue-router"; // important: brings the module into scope for augmentation

declare module "vue-router" {
    interface RouteMeta {
        requiresAuth?: boolean;
        requiresVisitor?: boolean;
        requiresCore?: boolean;
        /** The sidebar route that owns a nested detail page. */
        parentName?: string;
    }
}
