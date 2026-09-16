/**
 * 最终判据：用 audio 元素真播一下，看播放位置走不走。
 * （HTTP 能拉到 206 不等于能播 —— 防盗链/签名地址会返回数据但解码失败）
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const ROOT = __dirname
const PROFILE = path.join(ROOT, '.diag-run')
const SRC_CONFIG = path.join(process.env.APPDATA, 'lx-music-desktop', 'LxDatas', 'user_api.json')

app.setPath('userData', PROFILE)
require(path.join(ROOT, 'dist', 'main.js'))
const wait = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)
app.on('window-all-closed', () => {})

const MAX_SRC = Number(process.argv[2] || 8)
const WAIT_MS = Number(process.argv[3] || 8000)

app.whenReady().then(async () => {
  fs.mkdirSync(path.join(PROFILE, 'LxDatas'), { recursive: true })
  fs.copyFileSync(SRC_CONFIG, path.join(PROFILE, 'LxDatas', 'user_api.json'))

  let win = null
  for (let i = 0; i < 80; i++) {
    await wait(500)
    for (const w of BrowserWindow.getAllWindows().filter(x => !x.isDestroyed())) {
      try { if (await w.webContents.executeJavaScript('typeof window.lxApp') === 'object') { win = w; break } } catch (e) {}
    }
    if (win) break
  }
  if (!win) { log('没找到界面窗口'); app.exit(1); return }
  await wait(1500)

  const TEST = `(async () => {
    const A = window.lxApp
    const nap = ms => new Promise(r => setTimeout(r, ms))
    const out = []
    const apis = A.lx.list.slice(0, ${MAX_SRC})
    for (const api of apis) {
      const row = { name: api.name, id: api.id }
      try {
        await A.lx.enable(api.id)
        const ok = await A.lx.ready(15000)
        if (!ok) { row.err = '源没起来'; out.push(row); continue }
        const song = A.P.current()
        let url = null, q = '128k'
        try { url = await A.lx.url(song, q) } catch (e) {}
        if (!url) { try { q = '320k'; url = await A.lx.url(song, q) } catch (e) {} }
        if (!url) { row.err = '取不到地址'; out.push(row); continue }
        row.quality = q
        row.url = String(url).slice(-46)
        A.audio.volume = 0
        A.audio.src = url
        let perr = null
        try { await A.audio.play() } catch (e) { perr = e && e.name }
        const t0 = Date.now()
        while (Date.now() - t0 < ${WAIT_MS}) {
          await nap(400)
          if (A.audio.currentTime > 1) break
        }
        row.t = Number((A.audio.currentTime || 0).toFixed(2))
        row.dur = Number((A.audio.duration || 0).toFixed(2))
        row.errCode = A.audio.error ? A.audio.error.code : null
        row.playErr = perr
        row.playable = A.audio.currentTime > 1
      } catch (e) {
        row.err = String(e && e.message || e).slice(0, 60)
      }
      out.push(row)
    }
    return out
  })()`

  log('真实播放测试（每个源最多等 ' + (WAIT_MS / 1000) + ' 秒，看播放位置走不走）')
  log('')
  const res = await win.webContents.executeJavaScript(TEST)
  log('  音源'.padEnd(26) + '可播  已播/总长      地址尾部')
  log('  ' + '─'.repeat(96))
  let good = 0
  for (const r of res) {
    if (r.playable) good++
    const nm = (r.name || '').replace(/\s+/g, ' ').slice(0, 24)
    const stat = r.playable ? '✓' : (r.err ? '✗' : '✗')
    const tt = r.t != null ? (r.t + 's/' + (r.dur || 0) + 's') : (r.err || '')
    const tail = r.err ? (r.err + (r.errCode ? ' code=' + r.errCode : '')) : (r.url + (r.errCode ? '  code=' + r.errCode : ''))
    log('  ' + stat + ' ' + nm.padEnd(24) + String(tt).padEnd(14) + tail)
  }
  log('')
  log('  ★ 真能播的: ' + good + ' / ' + res.length)
  if (good) log('    ' + res.filter(r => r.playable).map(r => r.name).join('、'))
  app.exit(0)
})
