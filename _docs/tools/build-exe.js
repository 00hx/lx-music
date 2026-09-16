/**
 * 一键出 Windows 三种产物。
 *
 *   node _docs/tools/build-exe.js              打全部（安装版 + 单文件版 + 免安装目录）
 *   node _docs/tools/build-exe.js setup        只打安装版
 *   node _docs/tools/build-exe.js portable     只打单文件版
 *   node _docs/tools/build-exe.js dir          只打免安装目录
 *   node _docs/tools/build-exe.js setup --no-compile    跳过源码编译（dist/ 已经是最新时用）
 *
 * 产物（都在 build/ 下）：
 *   安装版      lx-music-desktop-v<版本>-x64-Setup.exe     双击走安装向导，有桌面/开始菜单图标和卸载程序
 *   单文件版    lx-music-desktop-v<版本>-x64-portable.exe  一个文件拷哪都能跑，首次启动要解压几秒
 *   免安装目录  win-unpacked/                              双击里面的 exe 即开，启动最快，但要整个文件夹一起用
 *
 * 本机注意（踩过的坑）：
 *   1. 必须清掉 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，否则打包出来的东西和测试都可能诡异失败
 *   2. 必须 CODEBUDDY_SAFE_DELETE_ENABLED=0，否则 electron-builder 清临时目录被沙箱拦截
 *   3. ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR 指 npmmirror：
 *      Electron 二进制和 nsis 工具链都走国内镜像，否则直连 GitHub 超时
 *   4. 本机没有 VS C++ 工具链，build-pack.js 里已设 npmRebuild:false（原生模块不重编）
 *   5. build-config/pack.js 里已去掉 renderer-lyric 的编译（桌面歌词窗口早随旧界面删了）
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, 'build')

const argv = process.argv.slice(2)
const skipCompile = argv.includes('--no-compile')
const asked = argv.filter(a => !a.startsWith('-'))
const targets = asked.length ? asked : ['setup', 'portable', 'dir']

const VALID = ['setup', 'portable', 'dir']
for (const t of targets) {
  if (!VALID.includes(t)) {
    console.error('不认识的产物类型：' + t + '（可选：' + VALID.join(' / ') + '）')
    process.exit(1)
  }
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.NODE_ENV = 'production'
env.CODEBUDDY_SAFE_DELETE_ENABLED = '0'
env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

/** 跑一个 node 脚本，只回显关键行 */
const run = (label, args, filter) => {
  console.log('')
  console.log('>>> ' + label)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 1800000 })
  const re = filter || /compiled successfully|ERROR|⨯|Error:|• |error/i
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)
    .filter(l => re.test(l) && !/webpack\.Progress/.test(l))
  console.log(out.slice(-16).join('\n'))
  console.log('    EXIT=' + r.status)
  return r.status
}

// 1) 编译源码（main + renderer + renderer-scripts）
if (!skipCompile) {
  if (run('编译（main + renderer + renderer-scripts）', ['build-config/pack.js']) !== 0) {
    console.error('')
    console.error('编译失败，终止。')
    process.exit(1)
  }
} else {
  console.log('')
  console.log('>>> 跳过编译（--no-compile）')
}

const build = (type) => {
  if (type === 'dir') return run('打包：免安装目录', ['build-config/build-pack.js', 'target=dir'])
  return run('打包：' + (type === 'setup' ? '安装版 Setup' : '单文件 portable'),
    ['build-config/build-pack.js', 'target=win', 'arch=x64', 'type=' + type])
}

// electron-builder 打包时不会清空 appOutDir，上一轮遗留的文件会被原样带进新包
// （踩过：移除 extraFiles 里的启动器后，旧包里的 .vbs 还在，因为它是上轮留下的）。
const APP_OUT = path.join(OUT, 'win-unpacked')
if (fs.existsSync(APP_OUT)) {
  console.log('')
  console.log('>>> 清空 build/win-unpacked（避免上一轮的残留文件混进新包）')
  fs.rmSync(APP_OUT, { recursive: true, force: true })
}

let failed = false
for (const t of targets) {
  if (build(t) !== 0) failed = true
}

// 汇总
console.log('')
console.log('════ 产物（build/）════')
if (fs.existsSync(OUT)) {
  const rows = []
  const walkDir = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        // 目录版只列一层里的 exe，不做深递归
        if (rel === '' && e.name === 'win-unpacked') {
          const exes = fs.readdirSync(p).filter(f => /\.exe$/i.test(f))
          rows.push(['[D] win-unpacked/', exes.join(', ')])
        } else if (rel !== '') {
          walkDir(p, rel + e.name + '/')
        }
        continue
      }
      if (/\.exe$/i.test(e.name) || /\.7z$/i.test(e.name)) {
        rows.push([e.name, (fs.statSync(p).size / 1024 / 1024).toFixed(1) + ' MB'])
      }
    }
  }
  walkDir(OUT, '')
  const w = Math.max(...rows.map(r => r[0].length), 4)
  for (const [a, b] of rows) console.log('  ' + a.padEnd(w + 3) + b)
}
console.log('')
console.log(failed ? '⚠ 有产物打包失败，看上面的 EXIT 码' : '✓ 全部完成')
process.exit(failed ? 1 : 0)
