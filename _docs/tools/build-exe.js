/**
 * 一次编译，出两种产物：
 *   1. build/win-unpacked/          —— 免安装目录（双击里面的 exe 即可，启动快）
 *   2. build/*-portable.exe         —— 单文件 exe（拷给别人方便，首次启动稍慢）
 */
const { spawnSync } = require('child_process')

const cwd = 'D:/project/workbuddy/lx-music'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.NODE_ENV = 'production'
env.CODEBUDDY_SAFE_DELETE_ENABLED = '0'
env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
env.ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

const run = (label, args) => {
  console.log('')
  console.log('>>> ' + label)
  const r = spawnSync('node', args, { cwd, env, encoding: 'utf8', shell: false, timeout: 900000 })
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)
    .filter(l => /compiled successfully|ERROR|⨯|Error:|PACK|• |error/i.test(l) && !/webpack\.Progress/.test(l))
  console.log(out.slice(-14).join('\n'))
  console.log('    EXIT=' + r.status)
  return r.status
}

// 1) 编译全部 target
if (run('编译（main + renderer + renderer-scripts）', ['build-config/pack.js']) !== 0) {
  console.log('编译失败，终止')
  process.exit(1)
}

// 2) 免安装目录
run('打包：免安装目录', ['build-config/build-pack.js', 'target=dir'])

// 3) 单文件 portable
run('打包：单文件 portable（首次会下载 nsis 资源）', ['build-config/build-pack.js', 'target=win', 'arch=x64', 'type=portable'])

// 汇总
const fs = require('fs')
const path = require('path')
const OUT = path.join(cwd, 'build')
console.log('')
console.log('════ 产物 ════')
if (fs.existsSync(OUT)) {
  for (const e of fs.readdirSync(OUT)) {
    const p = path.join(OUT, e)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      const exes = fs.readdirSync(p).filter(f => /\.exe$/i.test(f))
      console.log('  [D] ' + e + '/   →  ' + exes.join(', '))
    } else {
      console.log('      ' + e + '   ' + (st.size / 1024 / 1024).toFixed(1) + ' MB')
    }
  }
}
