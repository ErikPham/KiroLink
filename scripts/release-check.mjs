#!/usr/bin/env node
import { spawn } from 'node:child_process'

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

const steps = [
  [bin('pnpm'), ['typecheck']],
  [bin('pnpm'), ['test']],
  [bin('pnpm'), ['build']],
  [bin('npm'), ['pack', '--dry-run']],
]

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with exit code ${code ?? 'unknown'}`))
    })
    child.on('error', reject)
  })
}

for (const [cmd, args] of steps) {
  await run(cmd, args)
}
