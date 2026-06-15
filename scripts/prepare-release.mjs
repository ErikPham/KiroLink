#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

const DEFAULT_UNRELEASED = [
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '### Changed',
  '',
  '### Fixed',
  '',
].join('\n')

function usage() {
  process.stderr.write('Usage: node scripts/prepare-release.mjs <patch|minor|major|x.y.z> [--skip-check]\n')
}

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function bumpVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/u.test(kind)) return kind
  const parts = current.split('.').map((part) => Number(part))
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`Unsupported current version: ${current}`)
  }
  const [major, minor, patch] = parts
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'major') return `${major + 1}.0.0`
  throw new Error(`Unsupported release target: ${kind}`)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function trimSection(section) {
  return section.replace(/^\s+|\s+$/gu, '')
}

function parseCommits(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const groups = new Map([
    ['Added', []],
    ['Changed', []],
    ['Fixed', []],
    ['Docs', []],
    ['Internal', []],
  ])

  for (const line of lines) {
    const [hash, ...subjectParts] = line.split('\t')
    const subject = subjectParts.join('\t').trim()
    const match = subject.match(/^(\w+)(?:\([^)]*\))?!?:\s+(.+)$/u)
    const item = `- ${subject}${hash ? ` (${hash})` : ''}`
    if (!match) {
      groups.get('Internal').push(item)
      continue
    }
    const type = match[1]
    if (type === 'feat') groups.get('Added').push(item)
    else if (type === 'fix') groups.get('Fixed').push(item)
    else if (type === 'docs') groups.get('Docs').push(item)
    else if (type === 'refactor' || type === 'perf') groups.get('Changed').push(item)
    else groups.get('Internal').push(item)
  }

  return Array.from(groups.entries())
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => [`### ${title}`, '', ...items, ''].join('\n'))
    .join('\n')
    .trim()
}

function buildEntry(version, sectionBody) {
  return [`## [${version}] - ${today()}`, '', trimSection(sectionBody), ''].join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    usage()
    return
  }

  const skipCheck = args.includes('--skip-check')
  const targetArg = args.find((arg) => !arg.startsWith('-'))
  if (!targetArg) {
    usage()
    process.exit(1)
  }

  if (!skipCheck) {
    await exec(process.execPath, ['scripts/release-check.mjs'])
  }

  const packagePath = new URL('../package.json', import.meta.url)
  const changelogPath = new URL('../CHANGELOG.md', import.meta.url)
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const nextVersion = bumpVersion(packageJson.version, targetArg)

  const changelog = await readFile(changelogPath, 'utf8')
  if (changelog.includes(`## [${nextVersion}] - `)) {
    throw new Error(`CHANGELOG.md already contains version ${nextVersion}`)
  }

  const unreleasedMatch = changelog.match(/^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|$)/mu)
  if (!unreleasedMatch || unreleasedMatch.index === undefined) {
    throw new Error('CHANGELOG.md is missing an [Unreleased] section')
  }

  let unreleasedBody = trimSection(unreleasedMatch[1] ?? '')
  if (!unreleasedBody || unreleasedBody === trimSection(DEFAULT_UNRELEASED.replace(/^## \[Unreleased\]\n/u, ''))) {
    let range = ''
    try {
      const { stdout } = await exec(bin('git'), ['describe', '--tags', '--abbrev=0'])
      range = `${stdout.trim()}..HEAD`
    } catch {
      range = 'HEAD'
    }
    const { stdout } = await exec(bin('git'), ['log', '--format=%h%x09%s', range])
    unreleasedBody = parseCommits(stdout) || '### Changed\n\n- Internal release preparation.'
  }

  packageJson.version = nextVersion
  const nextPackage = `${JSON.stringify(packageJson, null, 2)}\n`
  const releaseEntry = buildEntry(nextVersion, unreleasedBody)
  const nextChangelog = changelog.replace(
    /^## \[Unreleased\]\n[\s\S]*?(?=^## \[|$)/mu,
    `${DEFAULT_UNRELEASED}\n${releaseEntry}\n`,
  )

  await writeFile(packagePath, nextPackage)
  await writeFile(changelogPath, nextChangelog)

  process.stdout.write([
    `Prepared ${nextVersion}.`,
    'Next steps:',
    '1. Review package.json and CHANGELOG.md',
    '2. Commit the release',
    `3. Tag v${nextVersion} and push`,
  ].join('\n') + '\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
