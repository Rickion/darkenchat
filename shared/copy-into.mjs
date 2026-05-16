#!/usr/bin/env node
// Copies the canonical shared/ directory into a package's src/_shared/.
// Run from the package root: `node ../shared/copy-into.mjs src/_shared`
// In Docker builds where the shared dir lives alongside the package
// (instead of one level up), the fallback path `./shared` is tried.
//
// The destination directory is wiped first so removed files don't linger.
import { existsSync, rmSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dest = resolve(process.cwd(), process.argv[2] ?? 'src/_shared')
const __dir = dirname(fileURLToPath(import.meta.url))

// 1. canonical: sibling to packages → resolves relative to this script
// 2. docker fallback: shared/ copied next to package
const candidates = [__dir, resolve(process.cwd(), 'shared'), resolve(process.cwd(), '..', 'shared')]
const src = candidates.find(p => existsSync(p) && p !== dest)
if (!src) {
  console.error('[shared] source dir not found in:', candidates)
  process.exit(1)
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
cpSync(src, dest, { recursive: true, filter: (p) => !p.endsWith('copy-into.mjs') && !p.endsWith('README.md') })
console.log(`[shared] copied ${src} → ${dest}`)
