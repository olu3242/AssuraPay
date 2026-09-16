import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { requirementForRoute } from './route-permissions';
const root = path.resolve('apps/web');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const pages = files(path.join(root, 'app'))
  .filter((p) => p.endsWith('page.tsx'))
  .map((p) =>
    path
      .relative(path.join(root, 'app'), path.dirname(p))
      .replaceAll('\\', '/'),
  );
function pageMatches(href: string) {
  const pathname = href.split(/[?#]/)[0].replace(/^\//, '').replace(/\/$/, '');
  return pages.some((page) => {
    const segments = page.split('/');
    const pattern = segments
      .map((s) =>
        s.startsWith('[[...')
          ? '(?:/.*)?'
          : s.startsWith('[...')
            ? '/.*'
            : s.startsWith('[')
              ? '/[^/]+'
              : s
                ? '/' + s
                : '',
      )
      .join('');
    return (
      new RegExp('^' + pattern + '$').test('/' + pathname) ||
      (!pathname && !page)
    );
  });
}
describe('frontend route synchronization', () => {
  it('every literal internal navigation link has a Next page', () => {
    const failures: string[] = [];
    for (const file of files(path.join(root, 'app')).filter((p) =>
      p.endsWith('.tsx'),
    )) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/href=["'](\/[^"']*)["']/g)) {
        if (!pageMatches(match[1]))
          failures.push(path.relative(root, file) + ': ' + match[1]);
      }
    }
    expect(failures).toEqual([]);
  });
  it('each inline protected-route permission matches the canonical route policy', () => {
    for (const file of files(path.join(root, 'app/api')).filter((p) =>
      p.endsWith('route.ts'),
    )) {
      const source = readFileSync(file, 'utf8');
      const keys = [
        ...source.matchAll(/requirePermission\(context,\s*['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      if (!keys.length) continue;
      const url =
        '/api/' +
        path
          .relative(path.join(root, 'app/api'), path.dirname(file))
          .replaceAll('\\', '/');
      const requirement = requirementForRoute(url, 'POST');
      if (requirement.access === 'permission')
        for (const key of keys)
          expect(key, file).toBe(requirement.permissionKey);
    }
  });
  it('frontend API references resolve to a declared backend route', () => {
    const failures: string[] = [];
    for (const file of files(path.join(root, 'app')).filter((p) =>
      p.endsWith('.tsx'),
    )) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function visit(node: ts.Node) {
        let value: string | undefined;
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node)
        )
          value = node.text;
        else if (ts.isTemplateExpression(node))
          value =
            node.head.text +
            node.templateSpans
              .map((span) => 'test-id' + span.literal.text)
              .join('');
        if (value?.startsWith('/api/')) {
          let matched = false;
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            try {
              requirementForRoute(value, method);
              matched = true;
              break;
            } catch {}
          }
          if (!matched) failures.push(path.relative(root, file) + ': ' + value);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(failures).toEqual([]);
  });
});
