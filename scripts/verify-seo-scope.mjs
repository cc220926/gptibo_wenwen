import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const base = 'd7df5ef63ba99577048baf2ab28512ee4d51c2df'
const allowed = new Set([
  'wrangler.jsonc', 'wrangler.production.example.jsonc', 'src/App.tsx',
  'src/lib/public-seo-metadata.ts', 'src/lib/public-catalog-bootstrap.ts', 'src/lib/use-store.ts', 'shared/public-bootstrap.ts', 'tests/public-catalog-bootstrap.test.ts', 'worker/public-seo.ts', 'worker/storefront-entry.ts',
  'shared/public-storefront.ts', 'shared/public-help.ts', 'public/public-content.css',
  'tests/public-seo.test.ts', 'tests/public-seo-boundaries.test.ts', 'tests/public-seo-resource-isolation.test.ts',
  'scripts/verify-seo-scope.mjs', 'scripts/seo-regression-loader.mjs',
  'scripts/scan-public-source.py', 'docs/seo-foundation-acceptance.md', 'docs/seo-foundation.md',
  'scripts/preprod/verify-config.mjs', 'scripts/preprod/http-smoke.mjs',
  'scripts/preprod/asset-audit.mjs', 'scripts/preprod/live-rollback.test.ts',
  'docs/seo-preproduction-rehearsal.md',
])
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const changed = [...new Set([...git('diff', '--name-only', base).trim().split('\n'), ...git('ls-files', '--others', '--exclude-standard').trim().split('\n')])].filter(Boolean)
assert.deepEqual(changed.filter(p => !allowed.has(p)), [], 'Changes outside SEO allowlist')
const sha = value => createHash('sha256').update(value).digest('hex')
let protectedCount = 0
for (const path of git('ls-tree', '-r', '--name-only', base).trim().split('\n')) {
  if (allowed.has(path)) continue
  assert.ok(existsSync(path), `Protected file removed: ${path}`)
  assert.equal(sha(readFileSync(path)), sha(execFileSync('git', ['show', `${base}:${path}`])), `Protected file changed: ${path}`)
  protectedCount++
}
const printer = ts.createPrinter({ removeComments: true })
function protectedApp(text, current) {
  const source = ts.createSourceFile('App.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const counts = { import: 0, effect: 0, link: 0 }
  const result = ts.transform(source, [context => root => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/lib/public-seo-metadata') { counts.import++; return undefined }
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect' && node.expression.arguments[0]?.getText(source).includes('syncPublicPageMetadata')) {
        assert.equal(node.expression.arguments[0].body.statements.length, 1, 'Only one metadata-only call allowed')
        const call = node.expression.arguments[0].body.statements[0].expression
        assert.ok(ts.isCallExpression(call) && call.expression.getText(source) === 'syncPublicPageMetadata')
        assert.equal(call.arguments.map(a => a.getText(source)).join('|'), 'page|{ plans: store.catalog, hiddenProductIds: store.hiddenProductIds, platformBranding: store.platformBranding }|pageTitle || brandName|description|store.catalogReady')
        counts.effect++; return undefined
      }
      if (ts.isJsxExpression(node) && node.getText(source) === '{document.documentElement.dataset.publicSeo === \'true\' && !store.partner && <a href="/help/">{t(\'购买指南\')}</a>}') { counts.link++; return undefined }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  if (current) assert.deepEqual(counts, { import: 1, effect: 1, link: 1 })
  else assert.deepEqual(counts, { import: 0, effect: 0, link: 0 })
  const output = printer.printFile(result.transformed[0]); result.dispose(); return output
}
assert.equal(protectedApp(readFileSync('src/App.tsx', 'utf8'), true), protectedApp(git('show', `${base}:src/App.tsx`), false), 'All App behavior outside metadata effect and help link must be identical')
function protectedStore(text, current) {
  const source = ts.createSourceFile('use-store.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let imports = 0, wrappers = 0
  const result = ts.transform(source, [context => root => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './public-catalog-bootstrap') { imports++; return undefined }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'readPublicCatalog') {
        assert.equal(node.arguments.length, 2)
        assert.equal(node.arguments[1].getText(source), 'shopSlug')
        const loader = node.arguments[0]
        assert.ok(ts.isArrowFunction(loader) && ts.isCallExpression(loader.body) && loader.body.expression.getText(source) === 'api')
        wrappers++; return ts.visitNode(loader.body, visit)
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  assert.deepEqual([imports, wrappers], current ? [1, 1] : [0, 0])
  const output = printer.printFile(result.transformed[0]); result.dispose(); return output
}
assert.equal(protectedStore(readFileSync('src/lib/use-store.ts', 'utf8'), true), protectedStore(git('show', `${base}:src/lib/use-store.ts`), false), 'Only the public catalog read may be adapted; buyer initialization, orders, mutations, retries and polling must be identical')
const scanner = readFileSync('scripts/scan-public-source.py', 'utf8').replace("    # XML sitemap namespace, not an outbound service integration.\n    'www.sitemaps.org',\n", '')
assert.equal(scanner, git('show', `${base}:scripts/scan-public-source.py`), 'Only the public sitemap XML namespace may be added to the source scanner')
console.log(JSON.stringify({ base, protectedFilesIdentical: protectedCount, originalWorkerIdentical: true, appBusinessAstIdentical: true, storePrivateAndMutationAstIdentical: true, changed }, null, 2))
