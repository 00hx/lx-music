// ⚠️ 必须是第一个 import：它带有副作用 —— 若当前进程被 ELECTRON_RUN_AS_NODE /
// NODE_OPTIONS 带成了 Node 模式，会重新拉起一个干净进程再退出（打包成 exe 双击时必需）。
// webpack 按 import 书写顺序执行，放这里才能保证早于下面所有初始化逻辑。
import './selfRelaunch'

import { app } from 'electron'
import './utils/logInit'
import '@common/error'
import {
  initGlobalData,
  initSingleInstanceHandle,
  applyElectronEnvParams,
  setUserDataPath,
  registerDeeplink,
  listenerAppEvent,
} from './app'
import { isLinux } from '@common/utils'
import { initAppSetting } from '@main/app'
import registerModules from '@main/modules'

// 初始化应用
const init = () => {
  console.log('init')
  void initAppSetting().then(() => {
    registerModules()
    global.lx.event_app.app_inited()
  })
}

initGlobalData()
initSingleInstanceHandle()
applyElectronEnvParams()
setUserDataPath()
registerDeeplink(init)
listenerAppEvent(init)


// https://github.com/electron/electron/issues/16809
void app.whenReady().then(() => {
  isLinux ? setTimeout(init, 300) : init()
})
