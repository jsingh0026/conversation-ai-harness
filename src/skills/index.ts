import type { AgentTool } from '../orchestrator/agent-tool.js';
import { createAppointmentSkills, type AppointmentConfig } from './appointment.skill.js';
import { createHandoverSkill, type HandoverConfig } from './handover.skill.js';
import { createUpdateContactSkill } from './update-contact.skill.js';

export { createUpdateContactSkill } from './update-contact.skill.js';
export { createHandoverSkill } from './handover.skill.js';
export { createAppointmentSkills } from './appointment.skill.js';
export { resolveDateRange } from './dates.js';

export interface SkillsConfig {
  handover?: HandoverConfig;
  appointment?: AppointmentConfig;
}

/**
 * The skill registry. Every skill the agent can use is assembled here — adding
 * a new skill is one import + one array entry, not a change to the orchestrator.
 */
export function createSkills(config: SkillsConfig = {}): AgentTool[] {
  return [
    createUpdateContactSkill(),
    createHandoverSkill(config.handover),
    ...createAppointmentSkills(config.appointment),
  ];
}
