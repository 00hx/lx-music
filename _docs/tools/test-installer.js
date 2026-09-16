/**
 * 安装程序冒烟测试（装到项目内的临时目录，全程不碰系统里其他东西）
 *
 *   1. 静默安装到 .test-install
 *   2. 用资源管理器启动（＝真实的双击环境，绕开本会话的 ELECTRON_RUN_AS_NODE 污染）
 *   3. 静默卸载
 *   4. 核对有无残留（目录 / 桌面快捷方式 / 开始菜单 / 注册表卸载项）
 *
 * 会短暂产生桌面与开始菜单快捷方式、以及一个 HKCU 卸载项，卸载后应全部消失。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = 'D:/project/workbuddy/lx-music'
const SETUP = path.join(ROOT, 'build', 'lx-music-desktop-v2.12.5-x64-Setup.exe')
const DIR = path.join(ROOT, '.test-install')
const EXE = path.join(DIR, 'lx-music-desktop.exe')
const UNINST = path.join(DIR, 'Uninstall lx-music-desktop.exe')
const LOG = path.join(process.env.APPDATA, 'lx-music-desktop', 'logs', 'main.log')

const HOME = os.homedir()
const DESKTOPS = [
  path.join(HOME, 'Desktop', 'LX Music.lnk'),
  path.join(HOME, 'OneDrive', 'Desktop', 'LX Music.lnk'),
  path.join(HOME, 'OneDrive', '桌面', 'LX Music.lnk'),
]
const STARTMENU = [
  path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'LX Music.lnk'),
  path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'lx-music-desktop.lnk'),
]

const log = (...a) => console.log(...a)
const nap = ms => new Promise(r => setTimeout(r, ms))
const exist = (...ps) => ps.filter(p => { try { return fs.existsSync(p) } catch (e) { return false } })

const psList = () => {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq lx-music-desktop.exe', '/NH'], { encoding: 'utf8' })
  return ((r.stdout || '') + '').split(/\r?\n/).filter(l => /lx-music-desktop\.exe/i.test(l)).length
}
const kill = () => spawnSync('taskkill', ['/F', '/IM', 'lx-music-desktop.exe'], { encoding: 'utf8' })

/** 查注册表里有没有卸载项 / 协议注册 */
const regQuery = (key, find) => {
  const r = spawnSync('reg', ['query', key, '/s', '/f', find], { encoding: 'utf8' })
  return (r.stdout || '').trim().split(/\r?\n/).filter(l => /lx-music|LX Music/i.test(l)).length
}

;(async () => {
  log('════ 安装程序冒烟测试 ════')
  log('  安装包: ' + SETUP)
  log('  存在:   ' + fs.existsSync(SETUP) + (fs.existsSync(SETUP) ? '  ' + (fs.statSync(SETUP).size / 1024 / 1024).toFixed(1) + ' MB' : ''))
  if (!fs.existsSync(SETUP)) { log('安装包不存在，终止'); process.exit(1) }

  // ── 测试前状态 ──
  log('')
  log('── 测试前状态 ──')
  kill(); await nap(600)
  log('  进程数:            ' + psList())
  log('  安装目录存在:      ' + fs.existsSync(DIR))
  log('  桌面快捷方式:      ' + (exist(...DESKTOPS).join(', ') || '无'))
  log('  开始菜单快捷方式:  ' + (exist(...STARTMENU).join(', ') || '无'))
  log('  注册表卸载项:      ' + regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'lx-music') + ' 条')
  log('  协议注册(lxmusic): ' + regQuery('HKCU\\Software\\Classes', 'lxmusic') + ' 条')

  // ── 1. 静默安装 ──
  log('')
  log('── 1. 静默安装到 ' + DIR + ' ──')
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch (e) { /* 首次没有 */ }
  const t0 = Date.now()
  const inst = spawnSync(SETUP, ['/S', '/D=' + DIR.replace(/\//g, '\\')], { encoding: 'utf8', timeout: 300000 })
  log('  安装耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒   退出码: ' + inst.status)
  await nap(1500)

  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR) : []
  log('  安装目录文件数: ' + files.length)
  log('  主程序:         ' + fs.existsSync(EXE))
  log('  卸载程序:       ' + fs.existsSync(UNINST))
  const asar = path.join(DIR, 'resources', 'app.asar')
  log('  app.asar:       ' + (fs.existsSync(asar) ? (fs.statSync(asar).size / 1024 / 1024).toFixed(1) + ' MB' : '缺失'))
  const leftover = files.filter(f => /\.vbs$/i.test(f))
  log('  包内 .vbs 残留: ' + (leftover.length ? leftover.join(', ') : '无 ✓'))

  log('')
  log('── 2. 快捷方式与注册表（安装后） ──')
  const d1 = exist(...DESKTOPS), s1 = exist(...STARTMENU)
  log('  桌面快捷方式:      ' + (d1.join(', ') || '无'))
  log('  开始菜单快捷方式:  ' + (s1.join(', ') || '无'))
  log('  注册表卸载项:      ' + regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'lx-music') + ' 条')
  log('  协议注册(lxmusic): ' + regQuery('HKCU\\Software\\Classes', 'lxmusic') + ' 条')

  // ── 3. 启动（走资源管理器，等于真实双击） ──
  log('')
  log('── 3. 启动安装后的程序（资源管理器双击） ──')
  let logBefore = ''
  try { logBefore = fs.readFileSync(LOG, 'utf8') } catch (e) { /* 还没日志 */ }
  spawnSync('explorer.exe', [EXE], { encoding: 'utf8' })
  let alive = 0
  for (let i = 0; i < 40; i++) {
    await nap(1000)
    alive = psList()
    if (alive >= 3) break
  }
  log('  存活进程数: ' + alive)
  let started = false
  try {
    const after = fs.readFileSync(LOG, 'utf8')
    started = after.length > logBefore.length && /App starting/.test(after.slice(logBefore.length))
  } catch (e) { /* 忽略 */ }
  log('  新写入启动日志: ' + started)
  log('  音源目录:       ' + (() => {
    const d = path.join(process.env.APPDATA, 'lx-music-desktop', 'sources')
    try { return d + '（' + fs.readdirSync(d).length + ' 个文件）' } catch (e) { return '未创建' }
  })())

  log('')
  log('── 4. 关闭并静默卸载 ──')
  kill(); await nap(2500)
  // 必须带 /currentuser：这是按用户安装（perMachine:false）时注册表里登记的卸载参数
  // （UninstallString 就是 `"…\Uninstall xxx.exe" /currentuser`，QuietUninstallString 再加 /S）。
  // 漏了它卸载程序会静默什么都不做、还返回 0，极易误判成"卸载有 bug"。
  const un = spawnSync(UNINST, ['/currentuser', '/S'], { encoding: 'utf8', timeout: 300000 })
  log('  卸载退出码: ' + un.status)
  await nap(12000)

  log('')
  log('── 5. 卸载后残留核对 ──')
  const d2 = exist(...DESKTOPS), s2 = exist(...STARTMENU)
  const dirGone = !fs.existsSync(DIR)
  const regLeft = regQuery('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'lx-music')
  log('  安装目录已删除:    ' + (dirGone ? '✓' : '✗ 还在: ' + DIR))
  log('  进程数:            ' + psList())
  log('  桌面快捷方式残留:  ' + (d2.join(', ') || '无 ✓'))
  log('  开始菜单残留:      ' + (s2.join(', ') || '无 ✓'))
  log('  注册表卸载项残留:  ' + regLeft + (regLeft ? ' 条 ✗' : ' ✓'))
  log('  用户数据保留:      ' + (fs.existsSync(path.join(process.env.APPDATA, 'lx-music-desktop')) ? '✓（%APPDATA%\\lx-music-desktop 未动）' : '✗ 被删了'))

  log('')
  log('════ 结论 ════')
  const ok = files.length > 10 && fs.existsSync(EXE) && started && alive >= 3 && dirGone
  log(ok ? '✓ 安装 → 启动 → 卸载 全链路正常' : '✗ 有问题，看上面哪一步是 ✗')
  process.exit(ok ? 0 : 1)
})()
