/**
 * 验证「免安装版」在把 app.asar 换成解包目录 app/ 之后仍能正常启动。
 * 走资源管理器启动（等价真实双击），看进程数 + 主进程日志。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const EXE = 'D:/project/workbuddy/lx-music/build/win-unpacked/lx-music-desktop.exe'
const LOG = path.join(process.env.APPDATA, 'lx-music-desktop', 'logs', 'main.log')
const wait = ms => new Promise(r => setTimeout(r, ms))

const psCount = () => {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq lx-music-desktop.exe', '/NH'], { encoding: 'utf8' })
  return ((r.stdout || '') + '').split(/\r?\n/).filter(l => /lx-music-desktop\.exe/i.test(l)).length
}
const kill = () => spawnSync('taskkill', ['/F', '/IM', 'lx-music-desktop.exe'], { encoding: 'utf8' })

;(async () => {
  console.log('启动前残留进程: ' + psCount())
  kill(); await wait(1200)

  let before = ''
  try { before = fs.readFileSync(LOG, 'utf8') } catch (e) { /* 首次没日志 */ }

  console.log('用资源管理器启动（等价双击）…')
  spawnSync('explorer.exe', [EXE], { encoding: 'utf8' })

  let alive = 0
  for (let i = 0; i < 40; i++) {
    await wait(1000)
    alive = psCount()
    if (alive >= 3) break
  }
  console.log('存活进程数: ' + alive)

  const after = fs.readFileSync(LOG, 'utf8')
  const fresh = after.slice(before.length)
  console.log('')
  console.log('── 新写入的日志 ──')
  console.log(fresh.split(/\r?\n/).filter(l => l.trim()).slice(0, 14).map(l => '   ' + l).join('\n'))

  const checks = {
    '窗口进程起来了': alive >= 3,
    '主进程日志有 App starting': /App starting/.test(fresh),
    '数据库初始化成功（原生模块能加载）': /db inited/.test(fresh),
    '没有 SQLITE 打不开的报错': !/SQLITE_CANTOPEN/.test(fresh),
  }
  console.log('')
  console.log('── 检查项 ──')
  for (const [k, v] of Object.entries(checks)) console.log('   ' + (v ? '✓' : '✗') + ' ' + k)

  console.log('')
  const pass = Object.values(checks).every(Boolean)
  console.log(pass ? '✓ 解包目录方案可用' : '✗ 有问题，考虑把 app.asar.bak 改回去')
  kill()
  process.exit(pass ? 0 : 1)
})()
