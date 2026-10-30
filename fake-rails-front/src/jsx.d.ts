import type { ReservedProps } from "@vue/runtime-dom";

type JsxEventHandlers = {
  onClick?: (...args: any[]) => void;
  onDblClick?: (...args: any[]) => void;
  onMouseEnter?: (...args: any[]) => void;
  onMouseLeave?: (...args: any[]) => void;
  onMouseDown?: (...args: any[]) => void;
  onMouseUp?: (...args: any[]) => void;
  onContextMenu?: (...args: any[]) => void;
  onBlur?: (...args: any[]) => void;
  onFocus?: (...args: any[]) => void;
  onKeydown?: (...args: any[]) => void;
  onKeyup?: (...args: any[]) => void;
  onInput?: (...args: any[]) => void;
  onChange?: (...args: any[]) => void;
  onSubmit?: (...args: any[]) => void;
  onScroll?: (...args: any[]) => void;
  onWheel?: (...args: any[]) => void;
  onTouchstart?: (...args: any[]) => void;
  onTouchend?: (...args: any[]) => void;
  onDrag?: (...args: any[]) => void;
  onDrop?: (...args: any[]) => void;
};

declare module "vue/jsx-runtime" {
  namespace JSX {
    interface IntrinsicAttributes extends ReservedProps, JsxEventHandlers {}
  }
}

declare global {
  namespace JSX {
    interface IntrinsicAttributes extends ReservedProps, JsxEventHandlers {}
  }
}

export {};
