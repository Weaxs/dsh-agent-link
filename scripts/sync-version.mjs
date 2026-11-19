import { readFileSync, writeFileSync } from 'node:fs'

const manifestPath = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const argument = process.argv[2]

if (argument === '--check') {
  const tag = process.argv[3]
  if (!tag) throw new Error('Usage: node scripts/sync-version.mjs --check <tag>')
  const expected = tag.startsWith('v') ? tag.slice(1) : tag
  if (expected !== manifest.version) {
    throw new Error(`Tag ${tag} does not match package.json version ${manifest.version}`)
  }
  console.log(`${manifest.name}@${manifest.version} matches ${tag}`)
} else if (argument) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(argument)) {
    throw new Error(`Invalid semantic version: ${argument}`)
  }
  manifest.version = argument
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Updated package.json to ${argument}`)
} else {
  console.log(manifest.version)
}
