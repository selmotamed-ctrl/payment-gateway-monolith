import { describe, expect, it } from "vitest";
import { ref } from "vue";
import { dc } from "../src/lib/dc";
import { PgTable } from "../src/data/table/Table";
import { mount, nextFrame } from "./helpers/render";

const rowsA = Array.from({ length: 25 }, (_, i) => ({ lineId: `a${i}`, v: `A${i + 1}` }));
const rowsB = Array.from({ length: 5 }, (_, i) => ({ lineId: `b${i}`, v: `B${i + 1}` }));
const data = ref<any[]>(rowsA);
const skip = ref(0);
const Host = dc(() => () => (
  <PgTable
    headers={[{ key: "v", label: "V", value: (r: any) => r.v }] as any}
    data={data.value}
    skip={skip.value}

  />
), {});

describe("table swap", () => {
  it("replaces rows when the page changes", async () => {
    const { el, unmount } = mount(Host, {});
    await nextFrame();
    expect(el.textContent).toContain("A1");
    data.value = rowsB;
    skip.value = 25;
    await nextFrame();
    await nextFrame();
    expect(el.textContent).toContain("B1");
    expect(el.textContent).not.toContain("A1");
    unmount();
  });
});
