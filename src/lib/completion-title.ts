import { AGENT_DISPLAY, isAgentId, type AgentId } from "@/lib/agents";

/** "<project> · <agent> is done". The agent name is the same one the Agents
 *  dialog shows. An unknown id still produces a title rather than dropping
 *  the notification. */
export function completionTitle(project: string, agent: AgentId | string): string {
  const name = isAgentId(agent) ? AGENT_DISPLAY[agent].name : agent;
  return `${project} · ${name} is done`;
}
