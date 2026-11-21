import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'

// Both legacy commands now enforce the combined scope against the same
// production business baseline. Neither feature waives the other's guards.
const base = 'd7df5ef63ba99577048baf2ab28512ee4d51c2df'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
if (process.argv[2] !== undefined) {
  assert.equal(process.argv.length, 3, 'Only the fixed baseline argument is supported')
  assert.match(process.argv[2], /^[a-f\d]{7,40}$/)
  assert.equal(git('rev-parse', process.argv[2]).trim(), base, 'Cannot move the protected business baseline')
}
const allowed = new Set([
  'wrangler.jsonc', 'wrangler.production.example.jsonc', 'src/App.tsx',
  'src/lib/public-seo-metadata.ts', 'src/lib/public-catalog-bootstrap.ts', 'src/lib/use-store.ts',
  'shared/public-bootstrap.ts', 'tests/public-catalog-bootstrap.test.ts',
  'worker/public-seo.ts', 'worker/storefront-entry.ts',
  'shared/public-storefront.ts', 'shared/public-help.ts', 'public/public-content.css',
  'tests/public-seo.test.ts', 'tests/public-seo-boundaries.test.ts', 'tests/public-seo-resource-isolation.test.ts',
  'scripts/verify-seo-scope.mjs', 'scripts/seo-regression-loader.mjs',
  'scripts/scan-public-source.py', 'docs/seo-foundation-acceptance.md', 'docs/seo-foundation.md',
  'scripts/preprod/verify-config.mjs', 'scripts/preprod/http-smoke.mjs',
  'scripts/preprod/asset-audit.mjs', 'scripts/preprod/live-rollback.test.ts',
  'docs/seo-preproduction-rehearsal.md',
  'scripts/release/monitor-queries.mjs', 'scripts/release/monitor-tail.mjs',
  'tests/release-monitor-tail.test.ts', 'docs/seo-production-release.md',
  'src/components/home-guidance.tsx', 'src/lib/home-guidance.ts', 'src/styles/home-guidance.css',
  'src/components/product-catalog.tsx', 'src/styles/storefront-home.css',
  'tests/home-guidance.test.ts', 'scripts/verify-homepage-scope.mjs', 'docs/homepage-guidance.md',
  'scripts/verify-storefront-scope.mjs', 'public/storefront-startup.css',
  'tests/storefront-first-paint.test.ts', 'docs/combined-storefront-preview.md',
])
const changed = [...new Set([
  ...git('diff', '--name-only', base).trim().split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').trim().split('\n'),
])].filter(Boolean)
assert.deepEqual(changed.filter(file => !allowed.has(file)), [], 'Changes outside combined storefront allowlist')

const sha = value => createHash('sha256').update(value).digest('hex')
let protectedCount = 0
for (const file of git('ls-tree', '-r', '--name-only', base).trim().split('\n')) {
  if (allowed.has(file)) continue
  assert.ok(existsSync(file), `Protected file removed: ${file}`)
  assert.equal(sha(readFileSync(file)), sha(execFileSync('git', ['show', `${base}:${file}`])), `Protected file changed: ${file}`)
  protectedCount++
}

const printer = ts.createPrinter({ removeComments: true })
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const print = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source)
function exactNamedImport(node, name) {
  assert.ok(node.importClause && !node.importClause.isTypeOnly && !node.importClause.name)
  const bindings = node.importClause.namedBindings
  assert.ok(bindings && ts.isNamedImports(bindings))
  assert.equal(bindings.elements.length, 1)
  assert.equal(bindings.elements[0].name.text, name)
  assert.equal(bindings.elements[0].propertyName, undefined)
  assert.equal(bindings.elements[0].isTypeOnly, false)
}

function protectedApp(text, current) {
  const source = parse('App.tsx', text)
  const counts = { metadataImport: 0, effect: 0, link: 0, guideImport: 0, guideStyleImport: 0, homepageBranch: 0 }
  const result = ts.transform(source, [context => root => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/lib/public-seo-metadata') {
        exactNamedImport(node, 'syncPublicPageMetadata'); counts.metadataImport++; return undefined
      }
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/components/home-guidance') {
        exactNamedImport(node, 'HomeGuidance'); counts.guideImport++; return undefined
      }
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './styles/home-guidance.css') {
        assert.equal(node.importClause, undefined); counts.guideStyleImport++; return undefined
      }
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect' && node.expression.arguments[0]?.getText(source).includes('syncPublicPageMetadata')) {
        const effect = node.expression
        assert.equal(effect.arguments.length, 2)
        const callback = effect.arguments[0]
        assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body))
        assert.equal(callback.parameters.length, 0)
        assert.equal(callback.modifiers?.length ?? 0, 0)
        assert.equal(callback.body.statements.length, 1, 'Only one metadata-only call allowed')
        const statement = callback.body.statements[0]
        assert.ok(ts.isExpressionStatement(statement))
        const call = statement.expression
        assert.ok(ts.isCallExpression(call) && call.expression.getText(source) === 'syncPublicPageMetadata')
        assert.equal(call.arguments.map(arg => arg.getText(source)).join('|'), 'page|{ plans: store.catalog, hiddenProductIds: store.hiddenProductIds, platformBranding: store.platformBranding }|pageTitle || brandName|description|store.catalogReady')
        assert.equal(effect.arguments[1].getText(source), '[page, store.catalog, store.hiddenProductIds, store.platformBranding, store.catalogReady, pageTitle, brandName, description]', 'Metadata dependency list must remain exact')
        counts.effect++; return undefined
      }
      if (ts.isJsxExpression(node) && node.getText(source) === '{document.documentElement.dataset.publicSeo === \'true\' && !store.partner && <a href="/help/">{t(\'购买指南\')}</a>}') {
        counts.link++; return undefined
      }
      if (ts.isConditionalExpression(node) && node.condition.getText(source) === "page === 'store'" && ts.isJsxFragment(node.whenTrue)) {
        counts.homepageBranch++
        return ts.factory.updateConditionalExpression(node, node.condition, node.questionToken, ts.factory.createNull(), node.colonToken, ts.visitNode(node.whenFalse, visit))
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  assert.deepEqual(counts, current
    ? { metadataImport: 1, effect: 1, link: 1, guideImport: 1, guideStyleImport: 1, homepageBranch: 1 }
    : { metadataImport: 0, effect: 0, link: 0, guideImport: 0, guideStyleImport: 0, homepageBranch: 1 })
  const output = printer.printFile(result.transformed[0]); result.dispose(); return output
}
assert.equal(protectedApp(readFileSync('src/App.tsx', 'utf8'), true), protectedApp(git('show', `${base}:src/App.tsx`), false), 'App handlers, product details, orders, checkout and dialogs outside homepage/metadata must remain identical')

function protectedStore(text, current) {
  const source = parse('use-store.ts', text)
  let imports = 0, wrappers = 0
  const result = ts.transform(source, [context => root => {
    const visit = node => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === './public-catalog-bootstrap') {
        exactNamedImport(node, 'readPublicCatalog'); imports++; return undefined
      }
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'readPublicCatalog') {
        assert.equal(node.arguments.length, 2)
        assert.equal(node.arguments[1].getText(source), 'shopSlug')
        const loader = node.arguments[0]
        assert.ok(ts.isArrowFunction(loader) && ts.isCallExpression(loader.body) && loader.body.expression.getText(source) === 'api')
        assert.equal(loader.parameters.length, 0)
        assert.equal(loader.modifiers?.length ?? 0, 0)
        wrappers++; return ts.visitNode(loader.body, visit)
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  assert.deepEqual([imports, wrappers], current ? [1, 1] : [0, 0])
  const output = printer.printFile(result.transformed[0]); result.dispose(); return output
}
assert.equal(protectedStore(readFileSync('src/lib/use-store.ts', 'utf8'), true), protectedStore(git('show', `${base}:src/lib/use-store.ts`), false), 'Only public catalog reading may be adapted; buyer initialization, orders, mutations, retries and polling must remain identical')

function catalogComputation(text) {
  const source = parse('product-catalog.tsx', text)
  const components = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProductCatalog')
  assert.equal(components.length, 1)
  const component = components[0]
  assert.ok(component.body)
  const statements = component.body.statements
  assert.ok(ts.isReturnStatement(statements.at(-1)))
  return {
    parameters: component.parameters.map(node => print(node, source)),
    modifiers: (component.modifiers ?? []).map(node => print(node, source)),
    computations: statements.slice(0, -1).map(node => print(node, source)).join('\n'),
  }
}
assert.deepEqual(catalogComputation(readFileSync('src/components/product-catalog.tsx', 'utf8')), catalogComputation(git('show', `${base}:src/components/product-catalog.tsx`)), 'Catalog prices, visibility, grouping, order and destinations must remain identical')

const guideSource = parse('home-guidance.tsx', readFileSync('src/components/home-guidance.tsx', 'utf8'))
const permittedImports = new Set(['react', 'lucide-react', '@/lib/storefront-i18n', '@/lib/home-guidance', './ui/button', './ui/dialog', './ui/input', './ui/accordion', '@/lib/api', './recharge-guide'])
for (const node of guideSource.statements) if (ts.isImportDeclaration(node)) {
  assert.ok(permittedImports.has(node.moduleSpecifier.text), `Unexpected guide dependency: ${node.moduleSpecifier.text}`)
  if (node.moduleSpecifier.text === '@/lib/api') assert.equal(node.importClause?.isTypeOnly, true, 'Guidance may import API types but not transaction functions')
}

const scanner = readFileSync('scripts/scan-public-source.py', 'utf8').replace("    # XML sitemap namespace, not an outbound service integration.\n    'www.sitemaps.org',\n", '')
assert.equal(scanner, git('show', `${base}:scripts/scan-public-source.py`), 'Only the public sitemap XML namespace may be added to the source scanner')
console.log(JSON.stringify({
  base, scope: 'combined-homepage-and-seo', protectedFilesIdentical: protectedCount,
  originalWorkerIdentical: true, appBusinessAstIdentical: true,
  storePrivateAndMutationAstIdentical: true, catalogComputationsIdentical: true,
  changed,
}, null, 2))
