import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Compare against the pre-redesign commit, including uncommitted changes.
// This is a scope guard, not a replacement for transaction regression tests.
const base = process.argv[2]
if (!base || !/^[a-f\d]{7,40}$/.test(base)) throw new Error('Usage: node scripts/verify-homepage-scope.mjs <base-commit>')
const allowed = new Set([
  'src/App.tsx', 'src/components/home-guidance.tsx', 'src/lib/home-guidance.ts',
  'src/styles/home-guidance.css', 'src/components/product-catalog.tsx', 'src/styles/storefront-home.css',
  'tests/home-guidance.test.ts', 'scripts/verify-homepage-scope.mjs', 'docs/homepage-guidance.md',
])
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const changed = [...new Set([
  ...git('diff', '--name-only', base).trim().split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').trim().split('\n'),
])].filter(Boolean)
assert.deepEqual(changed.filter(path => !allowed.has(path)), [], 'Changes outside the homepage allowlist')

const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const printer = ts.createPrinter({ removeComments: true })
function protectedApp(text) {
  const source = parse('src/App.tsx', text)
  let homepageBranches = 0
  const transformed = ts.transform(source, [context => root => {
    function visit(node) {
      if (ts.isImportDeclaration(node) && ['@/components/home-guidance', './styles/home-guidance.css'].includes(node.moduleSpecifier.text)) return undefined
      if (ts.isConditionalExpression(node) && node.condition.getText(source) === "page === 'store'" && ts.isJsxFragment(node.whenTrue)) {
        homepageBranches++
        return ts.factory.updateConditionalExpression(node, node.condition, node.questionToken, ts.factory.createNull(), node.colonToken, ts.visitNode(node.whenFalse, visit))
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit)
  }])
  assert.equal(homepageBranches, 1, 'Must isolate exactly the store-only JSX branch')
  const result = printer.printFile(transformed.transformed[0]); transformed.dispose()
  return result
}
const originalApp = git('show', `${base}:src/App.tsx`)
assert.equal(protectedApp(readFileSync('src/App.tsx', 'utf8')), protectedApp(originalApp), 'App handlers, detail pages, orders, checkout and dialogs must stay unchanged')

function catalogComputation(text) {
  const source = parse('src/components/product-catalog.tsx', text)
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProductCatalog')
  assert.ok(component?.body)
  const statements = component.body.statements
  assert.ok(ts.isReturnStatement(statements.at(-1)))
  return statements.slice(0, -1).map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join('\n')
}
assert.equal(catalogComputation(readFileSync('src/components/product-catalog.tsx', 'utf8')), catalogComputation(git('show', `${base}:src/components/product-catalog.tsx`)), 'Catalog prices, visibility, order and destinations must stay unchanged')
const guideSource = parse('home-guidance.tsx', readFileSync('src/components/home-guidance.tsx', 'utf8'))
const permittedImports = new Set(['react', 'lucide-react', '@/lib/storefront-i18n', '@/lib/home-guidance', './ui/button', './ui/dialog', './ui/input', './ui/accordion'])
for (const node of guideSource.statements) if (ts.isImportDeclaration(node)) assert.ok(permittedImports.has(node.moduleSpecifier.text), `Unexpected guide dependency: ${node.moduleSpecifier.text}`)
console.log(`PASS: ${changed.length} files in homepage scope; App outside store JSX and all catalog computations unchanged; no backend, API, payment or fulfillment changes.`)
