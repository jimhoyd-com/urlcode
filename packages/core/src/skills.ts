import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {shippedSkillFiles} from './shipped-skills.ts';

/**
 * Public, stable programmatic access to every skill this package ships, as
 * `@jimhoyd/urlcode/skills`. A host that builds its own agent-tooling or MCP
 * surface (for example a hosted service that wants to serve URLCode's
 * authoring skills to a model) should import `listShippedSkills` rather than
 * reading package-layout paths such as
 * `node_modules/@jimhoyd/urlcode/.claude/skills/urlcode-authoring/SKILL.md`
 * or `node_modules/@jimhoyd/urlcode/skills/urlcode/SKILL.md` directly: those
 * paths are internal packaging detail and can move without notice, while
 * this export's shape (`{name, version, text}[]`) is a supported contract
 * that stays stable across releases. `version` is this package's own
 * version, since a skill's text ships and versions together with the
 * package; it is not an independent per-skill version.
 */
const packageRoot=fileURLToPath(new URL('../../../',import.meta.url));

export interface ShippedSkill {
  /** The skill's directory name, stable across releases. */
  name:string;
  /** This package's own version; the skill's text ships and versions with it. */
  version:string;
  /** The skill's full SKILL.md text, including YAML frontmatter. */
  text:string;
}

/**
 * Returns every skill this package ships: its name, this package's version,
 * and the full SKILL.md text read fresh from the installed package. This is
 * the supported way to read shipped skill content; reaching into
 * `node_modules/@jimhoyd/urlcode/.claude/skills/...` or
 * `node_modules/@jimhoyd/urlcode/skills/...` directly is not.
 */
export async function listShippedSkills():Promise<ShippedSkill[]> {
  const pkg=JSON.parse(await readFile(packageRoot+'package.json','utf8')) as {version:string};
  return Promise.all(shippedSkillFiles.map(async skill=>({
    name:skill.name,
    version:pkg.version,
    text:await readFile(packageRoot+skill.file,'utf8'),
  })));
}
