#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

function usage() {
  process.stderr.write('Usage: node scripts/render-release-notes.mjs <version>\n')
}

function normalizeVersion(input) {
  return input.replace(/^v/u, '').trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

const rawVersion = process.argv.slice(2).find((arg) => arg !== '--')
if (!rawVersion) {
  usage()
  process.exit(1)
}

const version = normalizeVersion(rawVersion)
const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const pattern = new RegExp(`^## \\[${escapeRegExp(version)}\\] - .*$`, 'm')
const match = changelog.match(pattern)

if (!match || match.index === undefined) {
  process.stderr.write(`Version ${version} was not found in CHANGELOG.md\n`)
  process.exit(1)
}

const start = match.index + match[0].length
const rest = changelog.slice(start)
const nextHeading = rest.search(/\n## \[/u)
const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim()

if (!section) {
  process.stderr.write(`Version ${version} has no release notes body in CHANGELOG.md\n`)
  process.exit(1)
}

process.stdout.write(`${section}\n`)
