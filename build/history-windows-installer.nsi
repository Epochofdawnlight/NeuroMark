Unicode true
!include MUI2.nsh
!include FileFunc.nsh
!include "${STAGE}.nsh"

Name "NeuroMark"
OutFile "${INSTALLER}"
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\HistoryGrading"
InstallDirRegKey HKCU "Software\HistoryGrading" "InstallLocation"
SetCompressor /SOLID lzma
ShowInstDetails hide

VIProductVersion "1.5.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "NeuroMark"
VIAddVersionKey /LANG=2052 "FileDescription" "NeuroMark 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "1.5.0"
VIAddVersionKey /LANG=2052 "ProductVersion" "1.5.0"
VIAddVersionKey /LANG=2052 "LegalCopyright" "NeuroMark contributors"

!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\NeuroMark.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var VerifyPackage
Var UpgradeMode
Var BackupApp
Var LegacyLauncher

Function .onInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTUNPACK" $1
  IfErrors +2
  StrCpy $VerifyPackage 1
FunctionEnd

Function InspectDirectory
  StrCpy $UpgradeMode 0
  ClearErrors
  FileOpen $0 "$INSTDIR\.history-grading-install" r
  IfErrors done
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "HistoryGrading" 0 done
  StrCpy $UpgradeMode 1
done:
FunctionEnd

Function ValidateDirectory
  Call InspectDirectory
  StrCpy $LegacyLauncher 0
  StrCmp $UpgradeMode 1 check_upgrade
  IfFileExists "$INSTDIR\.history-grading-install" target_collision
  IfFileExists "$INSTDIR\Uninstall HistoryGrading.exe" target_collision
  IfFileExists "$INSTDIR\resources\app" target_collision
  IfFileExists "$INSTDIR\resources\app\*.*" target_collision
  !insertmacro CheckRuntimeCollisions
  Goto check_write
check_upgrade:
  IfFileExists "$INSTDIR\HistoryGrading.exe" 0 check_write
  IfFileExists "$INSTDIR\NeuroMark.exe" target_collision
  StrCpy $LegacyLauncher 1
check_write:
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors no_write
  StrCpy $2 ""
  GetTempFileName $2 "$INSTDIR"
  IfErrors no_write
  StrCmp $2 "" no_write
  Delete "$2"
  SetErrorLevel 0
  Return
target_collision:
  MessageBox MB_OK|MB_ICONEXCLAMATION "此目录中有与 NeuroMark 安装文件同名的内容。请选择其他目录。" /SD IDOK
  SetErrorLevel 1
  Abort
no_write:
  MessageBox MB_OK|MB_ICONEXCLAMATION "当前用户无法写入此目录。请选择默认目录或其他可写位置。" /SD IDOK
  SetErrorLevel 1
  Abort
FunctionEnd

Section "NeuroMark"
  SetShellVarContext current
  SetRegView 64
  Call ValidateDirectory
  StrCpy $BackupApp ""
  StrCmp $UpgradeMode 1 0 write_payload
  IfFileExists "$INSTDIR\resources\app\package.json" 0 write_payload
  ClearErrors
  GetTempFileName $BackupApp "$INSTDIR\resources"
  IfErrors incomplete
  Delete "$BackupApp"
  Rename "$INSTDIR\resources\app" "$BackupApp"
  IfErrors incomplete

write_payload:
  SetOverwrite try
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
  IfErrors restore_app

  StrCmp $BackupApp "" +2
  RMDir /r "$BackupApp"
  StrCmp $UpgradeMode 1 0 registry
  StrCmp $LegacyLauncher 1 0 +2
  Delete "$INSTDIR\HistoryGrading.exe"
  Delete "$INSTDIR\resources\models\u2netp.onnx"
  Delete "$INSTDIR\resources\native\win32-x64\scancpp_node.node"
  Delete "$INSTDIR\resources\native\win32-x64\build-state.json"
  RMDir "$INSTDIR\resources\models"
  RMDir "$INSTDIR\resources\native\win32-x64"
  RMDir "$INSTDIR\resources\native"

registry:
  StrCmp $VerifyPackage 1 installed
  StrCmp $LegacyLauncher 1 0 save_registry
  ReadRegStr $0 HKCU "Software\HistoryGrading" "InstallLocation"
  StrCmp $0 $INSTDIR 0 save_registry
  IfFileExists "$DESKTOP\历史阅卷.lnk" 0 +2
  CreateShortCut "$DESKTOP\历史阅卷.lnk" "$INSTDIR\NeuroMark.exe"
  IfFileExists "$SMPROGRAMS\历史阅卷.lnk" 0 +2
  CreateShortCut "$SMPROGRAMS\历史阅卷.lnk" "$INSTDIR\NeuroMark.exe"
  WriteRegDWORD HKCU "Software\HistoryGrading" "MigratedLegacyShortcuts" 1
save_registry:
  WriteRegStr HKCU "Software\HistoryGrading" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayName" "NeuroMark"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayVersion" "1.5.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "DisplayIcon" "$INSTDIR\NeuroMark.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "UninstallString" '$\"$INSTDIR\Uninstall HistoryGrading.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\NeuroMark 按题阅卷版"
  CreateShortCut "$SMPROGRAMS\NeuroMark 按题阅卷版\NeuroMark.lnk" "$INSTDIR\NeuroMark.exe"
  Goto installed

restore_app:
  StrCmp $BackupApp "" 0 restore_previous
  StrCmp $UpgradeMode 1 incomplete
  !insertmacro RemoveRuntimeFiles
  RMDir /r "$INSTDIR\resources\app"
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR\locales"
  Delete "$INSTDIR\.history-grading-install"
  Delete "$INSTDIR\Uninstall HistoryGrading.exe"
  Goto incomplete
restore_previous:
  RMDir /r "$INSTDIR\resources\app"
  Rename "$BackupApp" "$INSTDIR\resources\app"
incomplete:
  MessageBox MB_OK|MB_ICONSTOP "安装文件未能完整写入。请关闭 NeuroMark 后重试。" /SD IDOK
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
  MessageBox MB_OK|MB_ICONSTOP "找不到 NeuroMark 的安装标记，已停止卸载。" /SD IDOK
  SetErrorLevel 1
  Abort

remove_app:
  SetOutPath "$TEMP"
  ClearErrors
  IfFileExists "$INSTDIR\NeuroMark.exe" 0 remove_runtime
  Delete "$INSTDIR\NeuroMark.exe"
  IfErrors uninstall_incomplete
remove_runtime:
  !insertmacro RemoveRuntimeFiles
  IfErrors uninstall_incomplete
  IfFileExists "$INSTDIR\resources\app\*.*" 0 remove_registration
  RMDir /r "$INSTDIR\resources\app"
  IfErrors uninstall_incomplete
remove_registration:
  ReadRegStr $0 HKCU "Software\HistoryGrading" "InstallLocation"
  StrCmp $0 $INSTDIR 0 remove_files
  Delete "$SMPROGRAMS\NeuroMark 按题阅卷版\NeuroMark.lnk"
  RMDir "$SMPROGRAMS\NeuroMark 按题阅卷版"
  ReadRegDWORD $0 HKCU "Software\HistoryGrading" "MigratedLegacyShortcuts"
  StrCmp $0 1 0 +3
  Delete "$DESKTOP\历史阅卷.lnk"
  Delete "$SMPROGRAMS\历史阅卷.lnk"
  DeleteRegKey HKCU "Software\HistoryGrading"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\HistoryGrading"

remove_files:
  RMDir "$INSTDIR\resources"
  RMDir "$INSTDIR\locales"
  Delete "$INSTDIR\.history-grading-install"
  Delete "$INSTDIR\Uninstall HistoryGrading.exe"
  RMDir "$INSTDIR"
  Goto uninstalled
uninstall_incomplete:
  MessageBox MB_OK|MB_ICONSTOP "部分安装文件仍在使用。请关闭 NeuroMark 后重试卸载。" /SD IDOK
  SetErrorLevel 1
  Abort
uninstalled:
SectionEnd
