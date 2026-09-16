/**
 * 开发期的 UI 快速更新：把最新打包产物里的 app.asar 同步到「平时双击的那个免安装目录」。
 *
 * 用法：
 *   node _docs/tools/sync-asar.js            # build-new → build（默认）
 *   LX_BUILD_OUT=./build2 node _docs/tools/sync-asar.js
 *
 * 为什么有这个工具：
 *   界面改动（index.html / renderer.js / 内置音源）全都打包在 app.asar 里，
 *   所以 UI 迭代**不需要重新跑 electron-builder**——编译完把新 asar 换进去、重开程序就生效。
 *   只有 main 进程代码、原生模块、图标这类东西变了才需要完整打包。
 *
 * ⚠ 两个前提（都验证过）：
 *   1. 这个应用的 asar 完整性校验（EnableEmbeddedAsarIntegrityValidation fuse）是关的，
 *      所以替换 asar 不会导致启动被拒。换一个开了校验的应用就得连 exe 一起换。
 *   2. 程序运行中会锁住 asar —— 同步前先关掉程序，否则报 EBUSY。
 *
 * 完整打包（Setup/portable）只在「要发给别人」时才需要：node _docs/tools/build-exe.js
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..', '..')
const outDir = (process.env.LX_BUILD_OUT || './build-new').replace(/^\.\//, '')
const SRC = path.join(ROOT, outDir, 'win-unpacked', 'resources', 'app.asar')
const DST = path.join(ROOT, 'build', 'win-unpacked', 'resources', 'app.asar')

const md5 = f => {
  const h = crypto.createHash('md5')
  h.update(fs.readFileSync(f))
  return h.digest('hex')
}

if (!fs.existsSync(SRC)) {
  console.error('✗ 找不到新产物：' + SRC)
  console.error('  先跑一次打包：node _docs/tools/build-exe.js（或 build-exe.js dir 只出免安装目录）')
  process.exit(1)
}
if (!fs.existsSync(DST)) {
  console.error('✗ 找不到目标：' + DST)
  console.error('  build/win-unpacked 不在了？重新出一次包再同步。')
  process.exit(1)
}

const a = md5(SRC)
const b = md5(DST)
console.log('新: ' + SRC + '   ' + a.slice(0, 12))
console.log('旧: ' + DST + '   ' + b.slice(0, 12))
if (a === b) {
  console.log('')
  console.log('✓ 两边已经一致，不用同步')
  process.exit(0)
}

try {
  fs.copyFileSync(SRC, DST)
} catch (e) {
  console.error('')
  console.error('✗ 替换失败：' + e.code + ' ' + e.message)
  console.error('  最常见原因：程序正在运行，Windows 锁住了 asar。先关掉程序再跑一次。')
  process.exit(1)
}

console.log('')
console.log('✓ 已同步（' + md5(DST).slice(0, 12) + '）。重开程序生效。')
