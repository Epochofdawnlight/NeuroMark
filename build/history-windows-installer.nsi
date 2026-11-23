Unicode true
!include FileFunc.nsh

Name "NeuroMark"
Caption "NeuroMark 安装"
OutFile "${INSTALLER}"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\HistoryGrading"
InstallDirRegKey HKCU "Software\HistoryGrading" "InstallLocation"
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "1.2.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "NeuroMark"
VIAddVersionKey /LANG=2052 "FileDescription" "NeuroMark Windows 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "1.2.0"
VIAddVersionKey /LANG=2052 "ProductVersion" "1.2.0"
VIAddVersionKey /LANG=2052 "LegalCopyright" "NeuroMark contributors"

Var VerifyPackage
Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTUNPACK" $1
  IfErrors +2
  StrCpy $VerifyPackage 1
FunctionEnd

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"

Section "安装 NeuroMark"
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\.history-grading-install" read_marker
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*"
  IfErrors check_write
scan_directory:
  StrCmp $1 "." scan_next
  StrCmp $1 ".." scan_next
  FindClose $0
  Goto wrong_directory
scan_next:
  ClearErrors
  FindNext $0 $1
  IfErrors scan_end
  Goto scan_directory
scan_end:
  FindClose $0
  Goto check_write
read_marker:
  ClearErrors
  FileOpen $0 "$INSTDIR\.history-grading-install" r
  IfErrors wrong_directory
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "HistoryGrading" check_write
wrong_directory:
  MessageBox MB_OK|MB_ICONEXCLAMATION "请选择空目录，或先前按题阅卷版的安装目录。" /SD IDOK
  SetErrorLevel 1
  Abort
check_write:
  ClearErrors
  CreateDirectory "$INSTDIR"
  FileOpen $2 "$INSTDIR\.history-grading-write-test" w
  IfErrors no_write
  FileClose $2
  Delete "$INSTDIR\.history-grading-write-test"
  Goto unpack
no_write:
  MessageBox MB_OK|MB_ICONEXCLAMATION "当前用户无法写入此目录。请选择默认目录或其他可写位置。" /SD IDOK
  SetErrorLevel 1
  Abort
unpack:
  ; Put the previously verified application's dependency tree aside until extraction succeeds.
  IfFileExists "$INSTDIR\resources\app\package.json" 0 write_payload
  IfFileExists "$INSTDIR\resources\app.previous\package.json" incomplete
  ClearErrors
  Rename "$INSTDIR\resources\app" "$INSTDIR\resources\app.previous"
  IfErrors incomplete
write_payload:
  ClearErrors
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  IfErrors restore_app
  WriteUninstaller "$INSTDIR\Uninstall HistoryGrading.exe"
  IfErrors restore_app
  FileOpen $2 "$INSTDIR\.history-grading-install" w
  IfErrors restore_app
  FileWrite $2 "HistoryGrading"
  FileClose $2
  RMDir /r "$INSTDIR\resources\app.previous"
  StrCmp $VerifyPackage 1 installed
  WriteRegStr HKCU "Software\HistoryGrading" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayName" "NeuroMark"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayVersion" "1.2.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayIcon" "$INSTDIR\NeuroMark.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "UninstallString" '$\"$INSTDIR\Uninstall HistoryGrading.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\NeuroMark 按题阅卷版"
  CreateShortCut "$SMPROGRAMS\NeuroMark 按题阅卷版\NeuroMark.lnk" "$INSTDIR\NeuroMark.exe"
  Delete "$DESKTOP\历史阅卷.lnk"
  Delete "$SMPROGRAMS\历史阅卷.lnk"
  Delete "$INSTDIR\HistoryGrading.exe"
  Goto installed
restore_app:
  IfFileExists "$INSTDIR\resources\app.previous\package.json" 0 incomplete
  RMDir /r "$INSTDIR\resources\app"
  Rename "$INSTDIR\resources\app.previous" "$INSTDIR\resources\app"
incomplete:
  MessageBox MB_OK|MB_ICONSTOP "安装文件未能完整写入。请关闭 NeuroMark，再用安装包重试。" /SD IDOK
  SetErrorLevel 1
  Abort
installed:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ClearErrors
  FileOpen $0 "$INSTDIR\.history-grading-install" r
  IfErrors wrong_uninstall_directory
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "HistoryGrading" remove_app
wrong_uninstall_directory:
  MessageBox MB_OK|MB_ICONSTOP "找不到本版 NeuroMark 的安装标记，已停止卸载。" /SD IDOK
  SetErrorLevel 1
  Abort
remove_app:
  Delete "$SMPROGRAMS\NeuroMark 按题阅卷版\NeuroMark.lnk"
  RMDir "$SMPROGRAMS\NeuroMark 按题阅卷版"
  Delete "$INSTDIR\NeuroMark.exe"
  Delete "$INSTDIR\HistoryGrading.exe"
  Delete "$INSTDIR\Uninstall HistoryGrading.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  Delete "$INSTDIR\.history-grading-install"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "Software\HistoryGrading" "InstallLocation"
  StrCmp $0 $INSTDIR 0 +3
  DeleteRegKey HKCU "Software\HistoryGrading"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading"
SectionEnd
