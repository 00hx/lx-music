/* 空入口文件。
 *
 * 界面是自包含的单文件 HTML（src/renderer/index.html），样式和脚本全部内联在里面，
 * 不需要 webpack 打包任何 JS。保留这个文件只是给 webpack 提供一个 entry。
 *
 * 以后要往界面里加真正的模块化代码时，把入口换回 main.ts（或 main.js 里写 import），
 * 同时记得改 build-config/renderer/webpack.config.base.js 的 entry。
 */
