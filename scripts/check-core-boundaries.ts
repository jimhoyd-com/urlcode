// Core is the generic runtime. Optional extensions may depend on its public
// contract, but core must never take a dependency back on their implementation.
//
// Every way a module can name another is checked: static and type-only
// imports and re-exports, `import x = require()`, `typeof import('…')` types,
// `import()` with a literal, template or const-bound specifier, `require()`
// (including one made by `createRequire`) and `import.meta.resolve()`. A
// specifier that is only partly static is checked by its static prefix. A
// specifier with no static prefix at all cannot be checked, so it must be a
// reviewed runtime loader listed in `runtimeModuleLoaders` below.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

interface CoreBoundaryProblem {
  file: string;
  specifier: string;
  /** The optional extension(s) the specifier can reach, or undefined when it cannot be analysed. */
  extension?: string;
}

// Dynamic imports whose specifier is computed entirely at run time. Each one
// loads a project, operator or bundle module from a path core computed, never
// an optional extension package. Keyed by the repository-relative file and the
// specifier expression with whitespace removed. Add an entry only after
// reviewing that the new loader cannot reach packages/<extension>.
const runtimeModuleLoaders = new Set([
  'packages/core/src/compliance.ts: pathToFileURL(path).href',
  'packages/core/src/extension-bundles.ts: pathToFileURL(join(root,item.entry)).href',
  "packages/core/src/extensions.ts: pathToFileURL(modulePath).href+'?urlcode-extension-hook-epoch='+epoch",
  'packages/core/src/operator-host.ts: pathToFileURL(path).href',
  "packages/core/src/trusted-functions.ts: pathToFileURL(definition.source).href+'?urlcode-trusted-epoch='+this.epoch",
]);

const sourceFile = /\.(?:[cm]?[jt]s|tsx)$/;

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile() && sourceFile.test(path)) files.push(path);
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

/** A module specifier: `exact` when fully static, otherwise `text` is its static prefix. */
interface Specifier { text: string; exact: boolean; expression: string }

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

function isCreateRequire(node: ts.Expression): boolean {
  node = unwrap(node);
  if (!ts.isCallExpression(node)) return false;
  const callee = unwrap(node.expression);
  return (ts.isIdentifier(callee) && callee.text === 'createRequire') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire');
}

function moduleSpecifiers(file: string, source: string): Specifier[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  // Every const binding of a plain identifier, so `const loader = '…'; import(loader)`
  // is followed. A name bound more than once is ambiguous and left unresolved.
  const consts = new Map<string, ts.Expression | null>();
  // Local names that hold a require function made by createRequire().
  const requireNames = new Set<string>(['require']);
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const constant = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const name = node.name.text;
      consts.set(name, constant && !consts.has(name) ? node.initializer : null);
      if (isCreateRequire(node.initializer)) requireNames.add(name);
    }
    ts.forEachChild(node, collect);
  };
  collect(parsed);

  const evaluate = (node: ts.Expression, depth = 0): { text: string; exact: boolean } => {
    node = unwrap(node);
    if (depth > 8) return { text: '', exact: false };
    if (ts.isStringLiteralLike(node)) return { text: node.text, exact: true };
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = evaluate(span.expression, depth + 1);
        text += part.text;
        if (!part.exact) return { text, exact: false };
        text += span.literal.text;
      }
      return { text, exact: true };
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, depth + 1);
      if (!left.exact) return left;
      const right = evaluate(node.right, depth + 1);
      return { text: left.text + right.text, exact: right.exact };
    }
    if (ts.isIdentifier(node)) {
      const initializer = consts.get(node.text);
      if (initializer) return evaluate(initializer, depth + 1);
    }
    return { text: '', exact: false };
  };

  const specifiers: Specifier[] = [];
  const add = (node: ts.Expression | undefined): void => {
    if (node === undefined) return;
    specifiers.push({ ...evaluate(node), expression: node.getText(parsed).replace(/\s+/g, '') });
  };
  const isRequire = (callee: ts.Expression): boolean => {
    callee = unwrap(callee);
    if (ts.isIdentifier(callee)) return requireNames.has(callee.text);
    if (isCreateRequire(callee)) return true;
    // require.resolve(), or the resolve of a createRequire() result.
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && isRequire(callee.expression);
  };
  const isImportMetaResolve = (callee: ts.Expression): boolean => {
    callee = unwrap(callee);
    return ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ts.isMetaProperty(callee.expression) && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword && callee.expression.name.text === 'meta';
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression) || isImportMetaResolve(node.expression))) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function pathOf(file: string, specifier: string): string | undefined {
  try {
    if (specifier.startsWith('file:')) return fileURLToPath(specifier);
    return isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier);
  } catch {
    return undefined;
  }
}

const isPathLike = (text: string): boolean => text.startsWith('.') || isAbsolute(text) || text.startsWith('file:');

/** The extensions a specifier can reach: empty when none, undefined when it cannot be analysed. */
function reachedExtensions(root: string, file: string, specifier: Specifier, extensions: Map<string, string>): string[] | undefined {
  const { text, exact } = specifier;
  if (exact) {
    for (const [directory, packageName] of extensions) {
      if (text === packageName || text.startsWith(`${packageName}/`)) return [directory];
    }
    if (!isPathLike(text)) return [];
    const target = pathOf(file, text);
    if (target === undefined) return [];
    const segments = relative(root, target).split(sep);
    return segments[0] === 'packages' && segments[1] !== undefined && extensions.has(segments[1]) ? [segments[1]] : [];
  }

  // Only a prefix is static: report every extension the completed specifier could name.
  if (text === '') return undefined;
  const reached = new Set<string>();
  for (const [directory, packageName] of extensions) {
    if (packageName.startsWith(text) || text.startsWith(`${packageName}/`)) reached.add(directory);
  }
  if (isPathLike(text)) {
    const slash = text.lastIndexOf('/');
    // `./${x}` or `..${x}` has no static directory to anchor on.
    if (slash < 0) return undefined;
    const directory = pathOf(file, text.slice(0, slash + 1));
    if (directory === undefined) return undefined;
    const prefix = resolve(directory) + sep + text.slice(slash + 1);
    for (const extension of extensions.keys()) {
      const home = resolve(root, 'packages', extension) + sep;
      if (home.startsWith(prefix) || prefix.startsWith(home)) reached.add(extension);
    }
  }
  return [...reached];
}

export async function checkCoreBoundaries(root = resolve(fileURLToPath(new URL('../', import.meta.url)))): Promise<CoreBoundaryProblem[]> {
  const extensions = await optionalExtensions(root);
  const problems: CoreBoundaryProblem[] = [];
  for (const path of await filesUnder(resolve(root, 'packages/core/src'))) {
    const file = relative(root, path).split(sep).join('/');
    for (const specifier of moduleSpecifiers(path, await readFile(path, 'utf8'))) {
      const reached = reachedExtensions(root, path, specifier, extensions);
      if (reached === undefined) {
        if (!runtimeModuleLoaders.has(`${file}: ${specifier.expression}`)) problems.push({ file, specifier: specifier.expression });
      } else if (reached.length > 0) {
        problems.push({ file, specifier: specifier.exact ? specifier.text : specifier.expression, extension: reached.join(', ') });
      }
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await checkCoreBoundaries();
  if (problems.length > 0) {
    console.error('Core must not import optional extension implementations:');
    for (const problem of problems) {
      if (problem.extension !== undefined) console.error(`  ${problem.file}: ${JSON.stringify(problem.specifier)} reaches packages/${problem.extension}`);
      else console.error(`  ${problem.file}: ${JSON.stringify(problem.specifier)} has no static specifier to check; after confirming it cannot reach an extension, list it in runtimeModuleLoaders in scripts/check-core-boundaries.ts`);
    }
    process.exit(1);
  }
  console.log('Core boundary check: no optional extension imports.');
}
