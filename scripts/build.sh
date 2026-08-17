#!/usr/bin/env bash
# Build the host half with local dev tools and link it against the installed
# DSH runtime. A source checkout is accepted when present, but this fallback
# also works in runtime-only installations where the checkout has no
# node_modules directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f "$ROOT/node_modules/typescript/bin/tsc" ]; then
  echo "build: missing local TypeScript; run npm install --legacy-peer-deps --ignore-scripts first" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
TSC_ENTRY="$ROOT/node_modules/typescript/bin/tsc"
# dev_build_plugin currently reaches this script through a WSL bash launcher on
# this Windows host. Prefer node.exe when available so the generated links are
# Windows junctions, usable by both npm.cmd and the injected Windows host.
if [ -r /proc/version ] && grep -qi microsoft /proc/version && command -v node.exe >/dev/null 2>&1; then
  NODE_BIN="$(command -v node.exe)"
  TSC_ENTRY="$(wslpath -w "$TSC_ENTRY")"
fi

echo "=== Linking DSH runtime declarations ==="
"$NODE_BIN" - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

const candidates = [process.env.DSH_RUNTIME_NODE_MODULES]
if (process.platform === 'win32' && process.env.APPDATA) {
  candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
}
try {
  candidates.push(path.join(childProcess.execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai', 'dsh', 'node_modules'))
} catch {
  // The Windows node.exe fallback may inherit a Linux PATH; APPDATA above is
  // then the authoritative runtime location.
}

const runtime = candidates.find((candidate) => candidate && fs.existsSync(candidate))
if (!runtime) {
  throw new Error('cannot locate DSH runtime node_modules; set DSH_RUNTIME_NODE_MODULES')
}

for (const [name, relative] of [
  ['cordis', '@deepseek-ai/cordis'],
  ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-runtime'],
  ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-slots'],
  ['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
]) {
  const target = path.join(runtime, relative)
  const link = path.resolve('node_modules', name)
  if (!fs.existsSync(target)) throw new Error(`DSH runtime dependency missing: ${target}`)
  fs.rmSync(link, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}
NODE

echo "=== Compiling host source ==="
"$NODE_BIN" "$TSC_ENTRY" -p tsconfig.json
echo "=== Host build complete ==="
