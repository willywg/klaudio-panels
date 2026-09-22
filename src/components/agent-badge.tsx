import { AGENT_DISPLAY, type AgentId } from "@/lib/agents";

/** Which agent a row or tab belongs to. Rendered only when more than one
 *  agent is enabled — with one, a badge on every row says nothing. */
export function AgentBadge(props: { agent: AgentId; compact?: boolean }) {
  const d = () => AGENT_DISPLAY[props.agent];
  return (
    <span
      class={
        "inline-flex items-center shrink-0 rounded border font-medium leading-none " +
        (props.compact ? "px-1 py-[2px] text-[9px]" : "px-1.5 py-[3px] text-[9.5px] uppercase tracking-wide") +
        " " +
        d().badgeClass
      }
      title={d().name}
    >
      {props.compact ? d().short : d().name}
    </span>
  );
}
