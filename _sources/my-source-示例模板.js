/*!
 * @name 我的音源（示例模板）
 * @version 1.0.0
 * @author 老许
 * @description 可直接导入 LX Music 的音源骨架。默认走 mock 模式，先验证链路，再换成真实实现。
 * @homepage https://example.com/my-source
 */

// ────────────────────────────────────────────────────────────────
// LX Music 自定义音源契约 v2.0.0 (env: desktop)
// 全局只有 window.lx，里面的东西是白名单注入的，别想用 require/fs/process
// ────────────────────────────────────────────────────────────────

const { EVENT_NAMES, request, on, send } = window.lx

// 调试开关：true 时打开脚本窗口的 devtools（只在开发期用）
const OPEN_DEVTOOLS = false

// ── 1. 声明能力：告诉 LX 你这个源支持哪些平台 / 动作 / 音质 ──
// LX 会拿这份声明和白名单取交集，交集外的能力会被静默裁掉。
//
//   平台 id   : kw 酷我 / kg 酷狗 / tx QQ音乐 / wy 网易云 / mg 咪咕 / local 本地
//   动作      : musicUrl（在线平台只放这个）/ lyric / pic（后两个只对 local 放）
//   音质      : 128k / 320k / flac / flac24bit
const initInfo = {
  status: true,
  openDevTools: OPEN_DEVTOOLS,
  message: '',
  sources: {
    kw: {
      type: 'music',
      actions: ['musicUrl'],
      qualitys: ['128k', '320k', 'flac'],
    },
    // 想支持更多平台就照着加：
    // kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    // tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
  },
}

// ── 2. 拿播放地址：这是唯一真正要你写的东西 ──
//
// songInfo 的形状取决于平台，在线平台一般长这样：
//   { id, songmid, name, singer, albumName, interval, source, ... }
// 常见取值：songInfo.songmid / songInfo.id / songInfo.hash
//
// 返回值必须是 http(s) 字符串，长度 <= 2048。超了或者不是 http(s)，
// LX 会在 preload 那层直接判 failed，不会告诉你细节。

// ⚠️ 公开测试音频，仅用于验证「导入 → 初始化 → 请求 → 返回 URL → 播放」这条链路
//    真实使用请换成你自己的接口实现
const MOCK_URL = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'

// 真实实现长这样：请求你自己的后端，后端再拿着 songmid 去平台换真实地址
const getUrlFromMyBackend = (source, songInfo, quality) => {
  return new Promise((resolve, reject) => {
    const api = `https://your-api.example.com/url?source=${source}&id=${encodeURIComponent(songInfo.songmid)}&q=${quality}`

    request(api, {
      method: 'get',
      timeout: 8000, // 会被裁到最大 60 秒
      headers: {
        'User-Agent': 'lx-music/1.0',
      },
    }, (err, resp, body) => {
      if (err) return reject(err)
      if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`))
      // body 已是对象（LX 自动 JSON.parse 过了），拿不到就退回原始文本
      const url = body && body.url
      if (!url) return reject(new Error('接口没返回 url'))
      resolve(url)
    })
  })
}

// ── 3. 挂上请求处理器 ──
//
// LX 每次要播一首歌时都会触发这个事件，参数是：
//   source  : 平台 id
//   action  : 'musicUrl' | 'lyric' | 'pic'
//   info    : { type: 音质, musicInfo: 歌曲信息 }
on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('不支持的动作: ' + action))

  const { type: quality, musicInfo } = info

  // 想验证链路 → 返回 mock；上线 → 换成 getUrlFromMyBackend
  return Promise.resolve(MOCK_URL)
  // return getUrlFromMyBackend(source, musicInfo, quality)
})

// ── 4. 上报初始化结果 ──
// 必须调，否则 LX 会一直等，最后弹「源初始化失败」。
// updateAlert 可选：用来通知用户这个源有新版本了（每个源生命周期只能调一次）。
send(EVENT_NAMES.inited, initInfo)

// 想发更新提醒就取消注释：
// send(EVENT_NAMES.updateAlert, {
//   log: '1.0.0 -> 1.1.0，修复了 XX 平台的 320k 拿不到的问题',
//   updateUrl: 'https://your-blog.example.com/my-source',
// })

// ────────────────────────────────────────────────────────────────
// 附：window.lx 完整能力清单（全部来自 preload，环境是 desktop）
//
// EVENT_NAMES      : { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }
// request(url, opts, cb)   opts: { method, timeout, headers, body, form, formData }
//                          cb(err, resp, body)，resp: { statusCode, statusMessage, headers, bytes, raw, body }
//                          返回一个 abort 函数
// send(name, data) 只认 inited / updateAlert
// on(name, handler) 只认 request
// utils.crypto     : aesEncrypt(buffer, mode, key, iv) | rsaEncrypt(buffer, key) | randomBytes(size) | md5(str)
// utils.buffer     : from(...args) | bufToString(buf, format)
// utils.zlib       : inflate(buf) | deflate(data)   ← 都返回 Promise
// currentScriptInfo: { name, description, version, author, homepage, rawScript }
// version          : '2.0.0'
// env              : 'desktop'
//
// 注意：utils.crypto 用的是 Node 的 crypto，也就是说这个脚本其实
//      跑在有 Node 能力的隔离渲染进程里 —— 但 contextIsolation 开着，
//      只能看到上面这些被 contextBridge 显式暴露出去的东西。
// ────────────────────────────────────────────────────────────────
