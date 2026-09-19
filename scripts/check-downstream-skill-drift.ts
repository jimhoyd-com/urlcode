// Advisory, informational-only drift report between core's own skill copies
// (.claude/skills/) and copies shipped by other repositories that vendor
// them, such as urlcode-template's .claude/skills/urlcode-authoring/SKILL.md
// and .claude/skills/urlcode-operations/SKILL.md.
//
// This is deliberately NOT a "does downstream match core's main" check.
// A downstream repo commonly pins an older published core version, and its
// skill copy is *correctly* describing that pin's behavior even when it
// reads as a flat contradiction of core's current main (see issue #155 for
// a worked example: urlcode-template pins 0.4.0-alpha.1, predates the
// trusted-by-default reversal, and its sandboxed-by-default skill text is
// accurate for that pin). So this script never asserts which side is
// "right" and never fails: it only surfaces the raw amount of divergence so
// a human can judge, at release time, whether it reflects the pinned
// version or has gone stale.
//
// Runs only where the downstream repository is available as a sibling
// checkout (as it is in this environment). In an environment without that
// sibling clone -- normal CI included -- it skips gracefully and exits 0,
// per Option 1 in issue #155 ("report, don't enforce"): this must never
// fail the build.
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

interface DownstreamRepo {
  name: string;
  // Directory name to look for near this checkout: as a sibling of the
  // repository root, and (since this script also runs from inside a git
  // worktree nested a few levels below the ordinary checkout, e.g.
  // .claude/worktrees/<id>/) as a sibling of each ancestor directory up to
  // a small bound. An environment variable override always wins.
  dirName: string;
  envOverride: string;
  corePin: { manifestPath: string; dependency: string };
  skills: { name: string; corePath: string; downstreamPath: string }[];
}

const repos: DownstreamRepo[] = [
  {
    name: 'urlcode-template',
    dirName: 'urlcode-template',
    envOverride: 'URLCODE_TEMPLATE_PATH',
    corePin: { manifestPath: 'package.json', dependency: '@jimhoyd/urlcode' },
    skills: [
      {
        name: 'urlcode-authoring',
        corePath: '.claude/skills/urlcode-authoring/SKILL.md',
        downstreamPath: '.claude/skills/urlcode-authoring/SKILL.md',
      },
      {
        name: 'urlcode-operations',
        corePath: '.claude/skills/urlcode-operations/SKILL.md',
        downstreamPath: '.claude/skills/urlcode-operations/SKILL.md',
      },
    ],
  },
];

async function readIfExists(url: URL): Promise<string | undefined> {
  try {
    return await readFile(url, 'utf8');
  } catch {
    return undefined;
  }
}

function countDifferingLines(a: string, b: string): number {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const max = Math.max(linesA.length, linesB.length);
  let differing = 0;
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) differing++;
  }
  return differing;
}

const MAX_ANCESTOR_LEVELS = 6;

async function resolveSiblingRoot(repo: DownstreamRepo): Promise<{ url: URL; tried: string[] } | undefined> {
  const tried: string[] = [];

  const override = process.env[repo.envOverride];
  if (override !== undefined && override !== '') {
    const url = new URL(`${override.replace(/\/$/, '')}/`, `file://${process.cwd()}/`);
    tried.push(override);
    if ((await readIfExists(new URL('package.json', url))) !== undefined) return { url, tried };
  }

  // `../<dirName>/`, `../../<dirName>/`, ... relative to this repository's
  // own root, so a checkout nested inside worktree directories still finds a
  // sibling of the actual repository checkout.
  let prefix = '../';
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    const candidate = `${prefix}${repo.dirName}`;
    tried.push(candidate);
    const url = new URL(`${candidate}/`, root);
    if ((await readIfExists(new URL('package.json', url))) !== undefined) return { url, tried };
    prefix += '../';
  }

  return undefined;
}

async function main() {
  console.log('Downstream skill drift report (informational only; never fails this run)\n');

  for (const repo of repos) {
    const resolved = await resolveSiblingRoot(repo);
    if (resolved === undefined) {
      console.log(
        `- ${repo.name}: not available as a sibling checkout; skipping.\n` +
          `  Clone it alongside this repository (or set ${repo.envOverride}) to include it in this report.\n`,
      );
      continue;
    }
    const downstreamRoot = resolved.url;

    let pin = 'unknown (could not read pin)';
    const manifestRaw = await readIfExists(new URL(repo.corePin.manifestPath, downstreamRoot));
    if (manifestRaw !== undefined) {
      try {
        const manifest = JSON.parse(manifestRaw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        pin =
          manifest.dependencies?.[repo.corePin.dependency] ??
          manifest.devDependencies?.[repo.corePin.dependency] ??
          pin;
      } catch {
        // leave pin as unknown
      }
    }

    console.log(`- ${repo.name} (pins ${repo.corePin.dependency}@${pin}):`);

    for (const skill of repo.skills) {
      const corePath = new URL(skill.corePath, root);
      const downstreamPathUrl = new URL(skill.downstreamPath, downstreamRoot);
      const coreText = await readIfExists(corePath);
      const downstreamText = await readIfExists(downstreamPathUrl);

      if (coreText === undefined || downstreamText === undefined) {
        console.log(
          `  - ${skill.name}: could not read one side (core: ${coreText !== undefined}, downstream: ${downstreamText !== undefined}); skipping this skill.`,
        );
        continue;
      }

      if (coreText === downstreamText) {
        console.log(`  - ${skill.name}: identical to core's main.`);
        continue;
      }

      const differing = countDifferingLines(coreText, downstreamText);
      console.log(
        `  - ${skill.name}: ${differing} line(s) differ from core's current main. ` +
          `${repo.name} pins ${pin}, not main, so this may correctly reflect that ` +
          'pinned version rather than being stale -- review the diff and judge ' +
          'against the pin, do not assume either side is wrong.',
      );
    }
    console.log('');
  }

  console.log('Done. This report is advisory: it never fails the build (see issue #155, Option 1).');
}

await main();
