/**
 * 从 pdone/lx-music-source 拉取全部音源，存进项目根的 _sources/
 * 直连 raw.githubusercontent.com 在本机 timeout，走 ghproxy.net 镜像。
 */
const fs = require('fs')
const path = require('path')

const OUT = 'D:/project/workbuddy/lx-music/_sources'
const REPO = 'https://raw.githubusercontent.com/pdone/lx-music-source/main/'
const MIRRORS = [
  u => 'https://ghproxy.net/' + u,
  u => 'https://gh-proxy.com/' + u,
  u => u,
]

const LIST = ['sixyin', 'huibq', 'flower', 'grass', 'ikun', 'juhe', 'lx', 'qdy', 'changqing', 'huanyin']

async function grab(id) {
  const raw = REPO + id + '/latest.js'
  let lastErr = null
  for (const m of MIRRORS) {
    const url = m(raw)
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 20000)
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      const txt = await r.text()
      clearTimeout(t)
      if (r.ok && /@name/.test(txt)) {
        return { txt, via: url.includes('ghproxy') ? 'ghproxy' : 'direct' }
      }
      lastErr = new Error('HTTP ' + r.status)
    } catch (e) {
      clearTimeout(t)
      lastErr = e
    }
  }
  throw lastErr || new Error('全部线路失败')
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const ok = []
  const bad = []
  for (const id of LIST) {
    try {
      const { txt, via } = await grab(id)
      fs.writeFileSync(path.join(OUT, id + '.js'), txt)
      const name = (/@name\s+([^\n*]+)/.exec(txt) || [])[1]
      const ver = (/@version\s+([^\n*]+)/.exec(txt) || [])[1]
      console.log('  ✓ ' + (id + '.js').padEnd(16) + (txt.length / 1024).toFixed(1).padStart(6) + ' KB  ' +
        String(name || '?').trim().padEnd(22) + 'v' + String(ver || '?').trim() + '  [' + via + ']')
      ok.push(id)
    } catch (e) {
      console.log('  ✗ ' + id.padEnd(16) + e.message)
      bad.push(id)
    }
    await new Promise(r => setTimeout(r, 350))
  }

  console.log('')
  console.log('成功 ' + ok.length + ' / ' + LIST.length + (bad.length ? '，失败: ' + bad.join(', ') : ''))
  console.log('')
  console.log('=== _sources/ 现状 ===')
  for (const f of fs.readdirSync(OUT).sort()) {
    console.log('  ' + f.padEnd(24) + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + ' KB')
  }
})()
