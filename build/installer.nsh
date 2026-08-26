!ifndef BUILD_UNINSTALLER
  !define XIAOMU_UPGRADE_DATA "$INSTDIR.__xiaomu_upgrade_data"

  !macro preserveUpgradeDirectory DIRECTORY
    ${if} ${FileExists} "$INSTDIR\${DIRECTORY}\*.*"
      ${if} ${FileExists} "${XIAOMU_UPGRADE_DATA}\${DIRECTORY}\*.*"
        MessageBox MB_ICONSTOP|MB_TOPMOST "检测到未完成的旧升级备份：${XIAOMU_UPGRADE_DATA}\${DIRECTORY}$\r$\n请先保留该目录并联系开发者，安装已停止。"
        Abort
      ${endif}
      CreateDirectory "${XIAOMU_UPGRADE_DATA}"
      Rename "$INSTDIR\${DIRECTORY}" "${XIAOMU_UPGRADE_DATA}\${DIRECTORY}"
      ${if} ${FileExists} "$INSTDIR\${DIRECTORY}\*.*"
        MessageBox MB_ICONSTOP|MB_TOPMOST "无法保护 ${DIRECTORY} 目录，安装已停止。请关闭占用该目录的程序后重试。"
        Abort
      ${endif}
    ${endif}
  !macroend

  !macro restoreUpgradeDirectory DIRECTORY
    ${if} ${FileExists} "${XIAOMU_UPGRADE_DATA}\${DIRECTORY}\*.*"
      ${ifNot} ${FileExists} "$INSTDIR\${DIRECTORY}\*.*"
        Rename "${XIAOMU_UPGRADE_DATA}\${DIRECTORY}" "$INSTDIR\${DIRECTORY}"
      ${endif}
    ${endif}
  !macroend

  !macro customHeader
    Function restoreXiaoMuUpgradeData
      !insertmacro restoreUpgradeDirectory "models"
      !insertmacro restoreUpgradeDirectory "outputs"
      !insertmacro restoreUpgradeDirectory "runtime"
      !insertmacro restoreUpgradeDirectory "engines"
      !insertmacro restoreUpgradeDirectory "tools"
      RMDir "${XIAOMU_UPGRADE_DATA}"
    FunctionEnd

    Function .onGUIEnd
      # Also restores data when the user cancels the installer or installation
      # fails after the pre-upgrade move.
      Call restoreXiaoMuUpgradeData
    FunctionEnd
  !macroend

  !macro customInit
    # Electron Builder's default upgrade uninstaller recursively removes the
    # installation directory. Move user-owned data beside it first so a normal
    # overwrite install cannot delete models, outputs or the managed runtime.
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      !insertmacro preserveUpgradeDirectory "models"
      !insertmacro preserveUpgradeDirectory "outputs"
      !insertmacro preserveUpgradeDirectory "runtime"
      !insertmacro preserveUpgradeDirectory "engines"
      !insertmacro preserveUpgradeDirectory "tools"
    ${endif}
  !macroend

!endif

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    Call restoreXiaoMuUpgradeData
  !endif

  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${ifNot} ${isNoDesktopShortcut}
      Delete "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\app-icon-v2.ico" 0 "" "" "${APP_DESCRIPTION}"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}
  !endif

  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\app-icon-v2.ico" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  !endif

  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
