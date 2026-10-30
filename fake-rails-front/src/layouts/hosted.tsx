import { dc } from "kt-dc";

export const HostedLayout = dc(
  (props: { title?: string }, _expose, { slots }) => {
    return () => (
      <div class="pg-hosted">
        <div class="pg-hosted__card">
          {props.title ? <h2 style={{ marginTop: 0 }}>{props.title}</h2> : null}
          {slots.default?.()}
        </div>
      </div>
    );
  },
  { slots: ["default"], props: ["title"] },
);

export default HostedLayout;
