import { createSlot } from "vue";
import { dc } from "@/utils/dc";

export const HostedLayout = dc(
  (props: { title?: string }, _expose, { slots }) => {
    return () => (
      <div class="pg-hosted">
        <div class="pg-hosted__card">
          {props.title ? <h2 style={{ marginTop: 0 }}>{props.title}</h2> : null}
          {createSlot("default")}
        </div>
      </div>
    );
  },
  { slots: ["default"], props: ["title"] },
);

export default HostedLayout;
