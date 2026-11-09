declare module "pagedjs" {
  export class Previewer {
    preview(
      content: string | Element,
      stylesheets?: Array<string | Element>,
      renderTo?: Element | Document | string,
    ): Promise<{ total: number }>;
  }
}
