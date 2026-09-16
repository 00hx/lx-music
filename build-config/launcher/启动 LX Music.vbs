' ============================================================
'  LX Music 启动器
' ============================================================
'  为什么需要这个文件：
'
'  本机全局设了环境变量 ELECTRON_RUN_AS_NODE=1（还有 WorkBuddy 注入的 NODE_OPTIONS）。
'  这两个变量会让 Electron 应用**退化成一个纯 Node 解释器**：它不读 package.json 的
'  main 字段，直接找命令行参数里的脚本执行；双击 exe 时没有脚本参数，进程就立刻退出,
'  窗口永远不出现（而且不报任何错）。
'
'  在应用代码里没法自救 —— 那种模式下 Electron 根本不会加载应用的主进程代码。
'  所以只能在外面把变量摘掉再启动。
'
'  双击本文件即可：不会有任何黑框/窗口闪出来，静默拉起播放器。
'  想放桌面：右键 → 发送到 → 桌面快捷方式。
' ============================================================
Option Explicit

Dim sh, fso, base, exePath
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = fso.BuildPath(base, "lx-music-desktop.exe")

If Not fso.FileExists(exePath) Then
  MsgBox "找不到主程序：" & vbCrLf & exePath, 16, "LX Music"
  WScript.Quit 1
End If

' 把污染变量从当前进程环境里摘掉，子进程就不会继承
On Error Resume Next
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
sh.Environment("Process").Remove "NODE_OPTIONS"
On Error Goto 0

sh.CurrentDirectory = base
' 第二个参数 1 = 正常窗口（应用自己会显示界面）；第三个 False = 不等待
sh.Run """" & exePath & """", 1, False
