import { afterEach, describe, expect, it } from "vitest";
import {
  closeOverlay,
  isTopOverlay,
  openOverlay,
  overlayZIndex,
  resetOverlayStack,
} from "../src/lib/overlayStack";

afterEach(() => resetOverlayStack());

describe("overlay stack", () => {
  it("keeps only the newest modal surface interactive and above the drawer", () => {
    const drawer = openOverlay("drawer", () => undefined);
    const dialog = openOverlay("dialog", () => undefined);

    expect(overlayZIndex(dialog)).toBeGreaterThan(overlayZIndex(drawer));
    expect(isTopOverlay(dialog)).toBe(true);
    expect(isTopOverlay(drawer)).toBe(false);

    closeOverlay(dialog);
    expect(isTopOverlay(drawer)).toBe(true);
  });

  it("does not let menus and tooltips inflate the modal z-rank", () => {
    const dialog = openOverlay("dialog", () => undefined);
    const first = overlayZIndex(dialog);
    for (let index = 0; index < 40; index += 1) {
      const menu = openOverlay("menu", () => undefined);
      closeOverlay(menu);
    }
    expect(overlayZIndex(dialog)).toBe(first);
    expect(first).toBeLessThan(1200);
  });
});
