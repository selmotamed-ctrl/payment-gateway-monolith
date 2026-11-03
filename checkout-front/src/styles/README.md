# Styles

This directory contains the portal's shared visual foundation:

- `fintech-minimal.css` — design tokens, shell/table/form classes and RTL/LTR typography.
- `globals/` — global styles loaded by the app entrypoint.
- `command-palette.css` — admin global-search palette styles.

The design system is documented in `project-design/parts/03-admin-front/00-ui-system.md` for admin, and the corresponding merchant/checkout parts for those portals. The former `#app` CSS transform scaling system has been removed; do not reintroduce global transforms.
