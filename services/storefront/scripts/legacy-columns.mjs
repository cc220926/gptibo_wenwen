import {readFileSync} from 'node:fs'
const extensions = JSON.parse(readFileSync(new URL('../internal/importer/legacy-extensions.json', import.meta.url), 'utf8'))
// Only explicitly supported additive columns are accepted. Never drop unknown data.
export function supportedColumns(table, actual) {
  const extra = extensions[table.name] ?? []
  const expected = [...table.columns, ...extra.filter(c => actual.some(a => a.name === c.name))]
  const canonical = columns => JSON.stringify([...columns].sort((a,b) => a.name.localeCompare(b.name)))
  return canonical(actual) === canonical(expected)
}

// Older exports remain valid. New tables are accepted only with an explicit
// specification and mapping; required legacy tables must still all be present.
const optionalTables = JSON.parse(readFileSync(new URL('../internal/importer/legacy-optional-tables.json', import.meta.url), 'utf8'))
export function supportedTables(base, actual) {
  const known = [...base, ...optionalTables]
  if (new Set(actual).size !== actual.length || base.some(t => !actual.includes(t.name)) || actual.some(name => !known.some(t => t.name === name))) throw new Error('source tables differ from supported D1 schema')
  return known.filter(t => actual.includes(t.name)).sort((a,b) => a.name.localeCompare(b.name))
}
