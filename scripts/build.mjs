// Builds plugins.json, the index Larvyn reads, from plugins/<id>.json.
//
//   node scripts/build.mjs           write plugins.json
//   node scripts/build.mjs --check   fail if plugins.json is out of date
//
// An entry only says where a release is: id, version, repo, download and
// sha256. Everything else in the index (name, permissions, ...) is read from
// the larvyn.json inside the zip, so a listing can't claim less than the
// plugin asks for. Larvyn checks the manifest again when it installs.
//
// Needs Node 22 and the unzip command. No npm packages.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const check = process.argv.includes('--check')

// Kept in step with internal/plugins/manifest.go in larvyn/larvyn.
const PERMISSIONS = new Set(['project.read', 'project.env.read', 'terminal.run', 'artisan.run', 'stack.control', 'ui.notify', 'storage', 'network', 'project.env.keys'])
const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
const MAX_BYTES = 50 << 20 // Larvyn's install limit
const MAX_FILES = 2000
const ENTRY_KEYS = ['id', 'version', 'repo', 'download', 'sha256']

const errors = []
const fail = (where, msg) => errors.push(`${where}: ${msg}`)

function https(u) {
  try {
    return new URL(u).protocol === 'https:'
  } catch {
    return false
  }
}

function readEntry(file) {
  const where = `plugins/${file}`
  let e
  try {
    e = JSON.parse(readFileSync(join(root, 'plugins', file), 'utf8'))
  } catch (err) {
    fail(where, `not valid JSON: ${err.message}`)
    return null
  }
  const extra = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k))
  if (extra.length) fail(where, `unknown fields ${extra.join(', ')}; an entry has only ${ENTRY_KEYS.join(', ')}`)
  if (!ID.test(e.id ?? '')) fail(where, `id ${JSON.stringify(e.id)} is not a plugin id like "yourname.plugin"`)
  else if (file !== `${e.id}.json`) fail(where, `the file must be named ${e.id}.json`)
  if (!VERSION.test(e.version ?? '')) fail(where, `version ${JSON.stringify(e.version)} is not like 1.2.3`)
  if (!https(e.repo)) fail(where, 'repo must be an https link to the source')
  if (!https(e.download)) fail(where, 'download must be an https link to the release .zip')
  if (!SHA256.test(e.sha256 ?? '')) fail(where, 'sha256 must be 64 lowercase hex characters')
  return { ...e, file }
}

async function download(where, url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`download returned ${res.status}`)
  const len = Number(res.headers.get('content-length') || 0)
  if (len > MAX_BYTES) throw new Error(`the zip is ${len} bytes; the limit is ${MAX_BYTES}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error(`the zip is ${buf.length} bytes; the limit is ${MAX_BYTES}`)
  return buf
}

// manifestOf finds larvyn.json the way Larvyn does: at the top of the zip,
// or in its only folder.
function manifestOf(zip) {
  const dir = mkdtempSync(join(tmpdir(), 'larvyn-plugin-'))
  try {
    const file = join(dir, 'plugin.zip')
    writeFileSync(file, zip)
    const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 16 << 20 })
      .split('\n')
      .filter((n) => n && !n.startsWith('__MACOSX/') && !n.endsWith('.DS_Store'))
    const files = names.filter((n) => !n.endsWith('/'))
    if (files.length > MAX_FILES) throw new Error(`the zip has ${files.length} files; the limit is ${MAX_FILES}`)
    if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) throw new Error('the zip has paths outside its folder')
    const tops = new Set(names.map((n) => n.split('/')[0]))
    const at = files.includes('larvyn.json') ? 'larvyn.json' : tops.size === 1 ? `${[...tops][0]}/larvyn.json` : null
    if (!at || !files.includes(at)) throw new Error('no larvyn.json at the top of the zip or in its only folder')
    return JSON.parse(execFileSync('unzip', ['-p', file, at], { encoding: 'utf8', maxBuffer: 1 << 20 }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function build(e) {
  const where = `plugins/${e.file}`
  let zip, m
  try {
    zip = await download(where, e.download)
  } catch (err) {
    fail(where, `${e.download}: ${err.message}`)
    return null
  }
  const sum = createHash('sha256').update(zip).digest('hex')
  if (sum !== e.sha256) {
    fail(where, `sha256 is ${sum}, not ${e.sha256}`)
    return null
  }
  try {
    m = manifestOf(zip)
  } catch (err) {
    fail(where, err.message)
    return null
  }
  if (m.apiVersion !== 1) fail(where, `larvyn.json has apiVersion ${m.apiVersion}; the registry lists apiVersion 1`)
  if (m.id !== e.id) fail(where, `larvyn.json says id ${m.id}, the entry ${e.id}`)
  if (m.version !== e.version) fail(where, `larvyn.json says version ${m.version}, the entry ${e.version}`)
  if (typeof m.name !== 'string' || !m.name.trim()) fail(where, 'larvyn.json needs a name')
  const perms = Array.isArray(m.permissions) ? m.permissions : []
  for (const p of perms) if (!PERMISSIONS.has(p)) fail(where, `unknown permission ${p}`)
  return {
    id: e.id,
    name: m.name,
    version: e.version,
    description: m.description ?? '',
    author: m.author ?? '',
    larvyn: m.larvyn ?? '',
    permissions: perms,
    network: Array.isArray(m.network) ? m.network : [],
    repo: e.repo,
    download: e.download,
    sha256: e.sha256,
    size: zip.length,
  }
}

function readRevoked() {
  let list
  try {
    list = JSON.parse(readFileSync(join(root, 'revoked.json'), 'utf8'))
  } catch (err) {
    fail('revoked.json', `not valid JSON: ${err.message}`)
    return []
  }
  if (!Array.isArray(list)) {
    fail('revoked.json', 'must be a list')
    return []
  }
  // { "id": "...", "versions": ["1.0.0"] (or omitted for every version), "reason": "..." }
  list.forEach((r, i) => {
    if (!ID.test(r?.id ?? '')) fail(`revoked.json[${i}]`, 'needs a plugin id')
    if (r?.versions !== undefined && !(Array.isArray(r.versions) && r.versions.every((v) => VERSION.test(v)))) fail(`revoked.json[${i}]`, 'versions must be a list like ["1.0.0"]')
    if (typeof r?.reason !== 'string' || !r.reason.trim()) fail(`revoked.json[${i}]`, 'needs a reason, shown to the people who installed it')
  })
  return [...list].sort((a, b) => a.id.localeCompare(b.id))
}

const entries = readdirSync(join(root, 'plugins'))
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map(readEntry)
  .filter(Boolean)
const plugins = (await Promise.all(entries.map(build))).filter(Boolean)
const index = JSON.stringify({ apiVersion: 1, plugins, revoked: readRevoked() }, null, 2) + '\n'

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
const out = join(root, 'plugins.json')
if (check) {
  if (readFileSync(out, 'utf8') !== index) {
    console.error('plugins.json is out of date: run node scripts/build.mjs and commit it')
    process.exit(1)
  }
  console.log(`plugins.json is up to date (${plugins.length} plugins)`)
} else {
  writeFileSync(out, index)
  console.log(`wrote plugins.json (${plugins.length} plugins)`)
}
