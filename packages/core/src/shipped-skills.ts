/**
 * Canonical inventory of every SKILL.md this package packs (#590), shared by
 * `agent-context.ts` (`listSkills`/`getSkill`) and `skills.ts`
 * (`listShippedSkills`): the MCP-facing agent-context skill and the two
 * Claude Code plugin skills, all three published in the root package.json
 * `files` list. Those two modules read this single list rather than each
 * keeping their own copy, so a rename, a move or a fourth shipped skill only
 * needs to change here (#639). Keep it in step with what actually ships.
 */
export const shippedSkillFiles=[
  {name:'urlcode',file:'skills/urlcode/SKILL.md'},
  {name:'urlcode-authoring',file:'.claude/skills/urlcode-authoring/SKILL.md'},
  {name:'urlcode-operations',file:'.claude/skills/urlcode-operations/SKILL.md'},
] as const;
