// Core is the generic runtime. Optional extensions may depend on its public
// contract, but core must never take a dependency back on their implementation.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export interface CoreBoundaryProblem {
  file: string;
  specifier: string;
  extension: string;
}

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
  }
  return files;
}

async function optionalExtensions(root: string): Promise<Map<string, string>> {
  const extensions = new Map<string, string>();
  for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'core') continue;
    const manifestPath = resolve(root, 'packages', entry.name, 'package.json');
    const manifest = await readFile(manifestPath, 'utf8').catch(() => null);
    if (manifest === null) continue;
    const name = (JSON.parse(manifest) as { name?: unknown }).name;
    if (typeof name === 'string') extensions.set(entry.name, name);
  }
  return extensions;
}

function moduleSpecifiers(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function importedExtension(root: string, file: string, specifier: string, extensions: Map<string, string>): string | undefined {
  for (const [directory, packageName] of extensions) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) return directory;
  }

  if (!(specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:'))) return undefined;
  let target: string;
  try {
    target = specifier.startsWith('file:') ? fileURLToPath(specifier) : isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier);
  } catch {
    return undefined;
  }
  const segments = relative(root, target).split(sep);
  return segments[0] === 'packages' && segments[1] !== undefined && extensions.has(segments[1]) ? segments[1] : undefined;
}

export async function checkCoreBoundaries(root = resolve(fileURLToPath(new URL('../', import.meta.url)))): Promise<CoreBoundaryProblem[]> {
  const extensions = await optionalExtensions(root);
  const problems: CoreBoundaryProblem[] = [];
  for (const file of await filesUnder(resolve(root, 'packages/core/src'))) {
    for (const specifier of moduleSpecifiers(file, await readFile(file, 'utf8'))) {
      const extension = importedExtension(root, file, specifier, extensions);
      if (extension !== undefined) problems.push({ file: relative(root, file), specifier, extension });
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkCoreBoundaries();
  if (problems.length > 0) {
    console.error('Core must not import optional extension implementations:');
    for (const problem of problems) console.error(`  ${problem.file}: ${JSON.stringify(problem.specifier)} reaches packages/${problem.extension}`);
    process.exit(1);
  }
  console.log('Core boundary check: no optional extension imports.');
}
