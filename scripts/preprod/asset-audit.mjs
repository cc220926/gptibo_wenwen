#!/usr/bin/env node
// Read build files, never execute them. Remote response bytes are hashed in memory.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const usage = 'node scripts/preprod/asset-audit.mjs --candidate <dist> [--baseline <dist>] [--build-compatible <new directory>] [--origin <http(s) origin>]'
const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--candidate', '--baseline', '--build-compatible', '--origin'].includes(key) || !process.argv[i + 1] || options[key]) {
    console.error(JSON.stringify({ error: usage })); process.exit(2)
  }
  options[key] = process.argv[i + 1]
}
if (!options['--candidate']) { console.error(JSON.stringify({ error: usage })); process.exit(2) }
if (options['--build-compatible'] && !options['--baseline']) { console.error(JSON.stringify({ error: '--build-compatible requires --baseline' })); process.exit(2) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const assetOrigin = 'https://build.example.invalid'
const localExtension = /\.(?:m?js|css|woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico)(?:[?#].*)?$/i
const codeExtension = /\.(?:m?js|css)$/i

function filesUnder(root, prefix = '') {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name)
    return entry.isDirectory() ? filesUnder(root, relative) : entry.isFile() ? [relative] : []
  }).sort()
}

function buildGraph(directory) {
  const root = path.resolve(directory)
  const files = new Map(filesUnder(root).map(relative => ['/' + relative, path.join(root, relative)]))
  if (!files.has('/index.html')) throw new Error(`Build has no index.html: ${root}`)
  const edges = [], edgeIds = new Set(), required = new Set()
  const reference = (from, raw, kind) => {
    if (typeof raw !== 'string' || !raw.trim() || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) return
    let url
    try { url = new URL(raw, assetOrigin + from) } catch { return }
    if (url.origin !== assetOrigin || !localExtension.test(url.pathname)) return
    const target = decodeURIComponent(url.pathname)
    const id = `${from}|${target}|${kind}`
    if (!edgeIds.has(id)) { edges.push({ from, to: target, kind }); edgeIds.add(id) }
    required.add(target)
  }
  // Include every code asset, including chunks only reachable after interaction.
  for (const file of files.keys()) if (codeExtension.test(file)) required.add(file)
  const html = readFileSync(files.get('/index.html'), 'utf8')
  for (const tag of html.matchAll(/<(script|link|img)\b[^>]*>/gi)) {
    const attr = tag[0].match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)
    if (attr) reference('/index.html', attr[1], 'html-' + tag[1].toLowerCase())
  }
  for (const [file, absolute] of files) {
    if (/\.m?js$/i.test(file)) {
      const source = ts.createSourceFile(file, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      if (source.parseDiagnostics.length) throw new Error(`Cannot parse built JavaScript: ${file}`)
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          reference(file, node.moduleSpecifier.text, 'static-import')
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) {
          reference(file, node.arguments[0].text, 'dynamic-import')
        }
        // Vite/Rolldown preload maps contain root-relative "assets/..." strings.
        if (ts.isStringLiteralLike(node) && /^(?:\/)?assets\//.test(node.text)) {
          reference(file, '/' + node.text.replace(/^\//, ''), 'preload-or-asset')
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    } else if (/\.css$/i.test(file)) {
      const css = readFileSync(absolute, 'utf8')
      for (const value of css.matchAll(/url\(\s*["']?([^\s)'"\n]+)["']?\s*\)/g)) reference(file, value[1], 'css-url')
      for (const value of css.matchAll(/@import\s+["']([^"']+)["']/g)) reference(file, value[1], 'css-import')
    }
  }
  const assets = [...required].sort().map(asset => {
    const absolute = files.get(asset)
    return absolute ? { path: asset, bytes: statSync(absolute).size, sha256: sha256(readFileSync(absolute)) } : { path: asset, missing: true }
  })
  return { root, assets, edges: edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }
}

function mimeMatches(file, type) {
  const mime = type.split(';')[0].trim().toLowerCase()
  if (/\.m?js$/i.test(file)) return ['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mime)
  if (/\.css$/i.test(file)) return mime === 'text/css'
  if (/\.woff2$/i.test(file)) return ['font/woff2', 'application/font-woff2'].includes(mime)
  if (/\.woff$/i.test(file)) return ['font/woff', 'application/font-woff'].includes(mime)
  if (/\.svg$/i.test(file)) return mime === 'image/svg+xml'
  return !['text/html', 'application/json', ''].includes(mime)
}

function buildCompatible(candidate, baselineDirectory, outputDirectory) {
  const baseline = buildGraph(baselineDirectory), output = path.resolve(outputDirectory)
  if (existsSync(output)) throw new Error('Compatibility output must be a new directory')
  for (const input of [baseline.root, candidate.root]) {
    const relative = path.relative(input, output)
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Compatibility output cannot be inside an input build')
  }
  if (candidate.assets.some(asset => asset.missing) || baseline.assets.some(asset => asset.missing)) throw new Error('Cannot package a build with missing referenced assets')
  const baselineFiles = filesUnder(baseline.root)
  const sourceFiles = new Map(baselineFiles.map(relative => ['/' + relative, {
    source: path.join(baseline.root, relative), sha256: sha256(readFileSync(path.join(baseline.root, relative))),
  }]))
  const added = []
  for (const asset of candidate.assets) {
    const existing = sourceFiles.get(asset.path)
    if (existing && existing.sha256 !== asset.sha256) throw new Error(`Asset collision has different bytes: ${asset.path}`)
    if (!existing) {
      sourceFiles.set(asset.path, { source: path.join(candidate.root, asset.path.slice(1)), sha256: asset.sha256 })
      added.push(asset.path)
    }
  }
  // No candidate HTML, robots, headers, redirects or Worker config is copied.
  const protectedFiles = ['/index.html', '/robots.txt', '/_headers', '/_redirects', '/_routes.json']
  if (added.some(file => protectedFiles.includes(file))) throw new Error('Candidate routing file may not replace the baseline')
  mkdirSync(path.dirname(output), { recursive: true })
  const temporary = mkdtempSync(path.join(path.dirname(output), '.seo-compatible-'))
  try {
    for (const [file, record] of sourceFiles) {
      const bytes = readFileSync(record.source)
      if (sha256(bytes) !== record.sha256) throw new Error(`Input changed while packaging: ${file}`)
      const target = path.join(temporary, file.slice(1))
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, bytes, { flag: 'wx', mode: statSync(record.source).mode & 0o777 })
    }
    const packaged = buildGraph(temporary)
    if (packaged.assets.some(asset => asset.missing)) throw new Error('Combined asset dependency graph is incomplete')
    for (const relative of baselineFiles) {
      if (sha256(readFileSync(path.join(temporary, relative))) !== sourceFiles.get('/' + relative).sha256) throw new Error(`Baseline file changed: ${relative}`)
    }
    renameSync(temporary, output)
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
  return { output, sourceBaseline: baseline.root, preservedBaselineFiles: baselineFiles.length, added,
    unhashedAdded: added.filter(file => !/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(file)),
    baselineHtmlPreserved: true, bothDependencyGraphsComplete: true,
    requiresNewWorkerVersion: true, originalVersionNotModified: true }
}

async function remoteAudit(origin, assets) {
  const parsed = new URL(origin)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('--origin must be an HTTP(S) origin without credentials, path, query or fragment')
  const results = []
  for (const asset of assets) {
    if (asset.missing) continue
    try {
      const response = await fetch(new URL(asset.path, parsed), {
        redirect: 'manual', signal: AbortSignal.timeout(15000),
        headers: { Accept: '*/*', 'Cache-Control': 'no-cache' },
      })
      const contentType = response.headers.get('content-type') ?? ''
      const maxBytes = Math.max(asset.bytes * 2, 1_000_000)
      const reader = response.body?.getReader(), chunks = []
      let bytes = 0
      if (reader) for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > maxBytes) { await reader.cancel(); throw new Error('Response exceeds bounded audit size') }
        chunks.push(value)
      }
      const actualHash = sha256(Buffer.concat(chunks))
      results.push({ path: asset.path, status: response.status, contentType, bytes,
        sha256: actualHash, expectedSha256: asset.sha256,
        ok: response.status === 200 && mimeMatches(asset.path, contentType) && bytes === asset.bytes && actualHash === asset.sha256 })
    } catch (error) {
      results.push({ path: asset.path, ok: false, error: error instanceof Error ? error.message : 'HTTP audit failed' })
    }
  }
  return { origin: parsed.origin, results, failed: results.filter(result => !result.ok) }
}

try {
  const candidate = buildGraph(options['--candidate'])
  const report = { candidate, compatibleBuild: null, local: null, remote: null, ok: true }
  report.ok = !candidate.assets.some(asset => asset.missing)
  if (options['--baseline']) {
    if (options['--build-compatible']) report.compatibleBuild = buildCompatible(candidate, options['--baseline'], options['--build-compatible'])
    const baseline = buildGraph(report.compatibleBuild?.output ?? options['--baseline'])
    const baselineFiles = new Map(filesUnder(baseline.root).map(file => ['/' + file, path.join(baseline.root, file)]))
    const checks = candidate.assets.filter(asset => !asset.missing).map(asset => {
      const baselinePath = baselineFiles.get(asset.path)
      const actualHash = baselinePath ? sha256(readFileSync(baselinePath)) : null
      return { path: asset.path, present: Boolean(baselinePath), identical: actualHash === asset.sha256 }
    })
    report.local = { baselineRoot: baseline.root, checked: checks.length,
      missingOrChanged: checks.filter(check => !check.identical),
      baselineMissingReferences: baseline.assets.filter(asset => asset.missing),
      baselineHtmlSha256: sha256(readFileSync(path.join(baseline.root, 'index.html'))) }
    report.ok &&= report.local.missingOrChanged.length === 0 && report.local.baselineMissingReferences.length === 0
  }
  if (options['--origin']) {
    report.remote = await remoteAudit(options['--origin'], candidate.assets)
    report.ok &&= report.remote.failed.length === 0
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Asset audit failed' }))
  process.exitCode = 2
}
