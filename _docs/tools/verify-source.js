#!/usr/bin/env node
/**
 * 源码完整性 / 改动检测
 *
 * 用途：把当前工作目录和原始源码包对比，查出
 *   ① 有没有文件丢失  ② 有没有新增文件  ③ 哪些文件被改过
 *
 * 用法：
 *   node verify-source.js <原始目录> <工作目录> [排除的目录名,逗号分隔]
 *
 * 例：
 *   node _docs/tools/verify-source.js \
 *     C:/Users/许杭/WorkBuddy/2026-09-15-15-32-48/lx-music-desktop/lx-music-desktop-master \
 *     D:/project/workbuddy/lx-music \
 *     _docs,_sources
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const [, , ORIG, DST, EXCLUDE_ARG] = process.argv

if (!ORIG || !DST) {
  console.error('用法: node verify-source.js <原始目录> <工作目录> [排除目录,逗号分隔]')
  process.exit(1)
}

const PRUNE = new Set([
  'node_modules', 'dist', '.git', '.vscode',
  ...(EXCLUDE_ARG ? EXCLUDE_ARG.split(',').map(s => s.trim()).filter(Boolean) : []),
])

const hashCache = new Map()
function hash(file) {
  if (hashCache.has(file)) return hashCache.get(file)
  const h = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
  hashCache.set(file, h)
  return h
}

function collect(root) {
  const out = new Map()
  ;(function walk(p, rel) {
    let entries
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (PRUNE.has(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(p, e.name), r)
      else out.set(r, path.join(p, e.name))
    }
  })(root, '')
  return out
}

console.log(`原始目录: ${ORIG}`)
console.log(`工作目录: ${DST}`)
console.log(`排除项  : ${[...PRUNE].join(', ')}`)
console.log('')

const a = collect(ORIG)
const b = collect(DST)

const missing = []
const added = []
const changed = []
const same = []

for (const [rel, fa] of a) {
  if (!b.has(rel)) { missing.push(rel); continue }
  if (hash(fa) === hash(b.get(rel))) same.push(rel)
  else changed.push(rel)
}
for (const rel of b.keys()) if (!a.has(rel)) added.push(rel)

const line = (label, arr) => {
  console.log(`── ${label}: ${arr.length}`)
  arr.slice(0, 40).forEach(f => console.log('   ' + f))
  if (arr.length > 40) console.log(`   ... 另有 ${arr.length - 40} 个`)
  console.log('')
}

console.log('=== 汇总 ===')
console.log(`原始文件: ${a.size}    工作目录文件: ${b.size}`)
console.log(`  一致        : ${same.length}`)
console.log(`  被改动      : ${changed.length}`)
console.log(`  丢失        : ${missing.length}`)
console.log(`  新增        : ${added.length}`)
console.log('')

if (missing.length) line('丢失（原始有、工作目录没有）', missing)
if (changed.length) line('被改动', changed)
if (added.length) line('新增', added)

if (!missing.length && !changed.length && !added.length) {
  console.log('结论：两棵目录完全一致。')
} else {
  console.log('结论：存在差异，见上方清单。')
}
