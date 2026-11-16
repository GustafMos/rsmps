; Custom NSIS page for the RSMPS installer (electron-builder `nsis.include`).
; An UNTICKED checkbox: "Download FFmpeg after install". This installer downloads nothing. If ticked it only writes
; %APPDATA%\RSMPS\addon-requests.json; on first launch the app reads and deletes that file and runs its own, single
; add-on install flow (download, SHA-256 check, unpack). See desktop/addons/ and docs/RELEASING.md.
!include nsDialogs.nsh
!include LogicLib.nsh

; The script is compiled twice (installer, then the uninstaller stub); the page functions exist only in the installer pass.
!ifndef BUILD_UNINSTALLER
Var RsmpsFfmpegBox
Var RsmpsFfmpegWanted

Function RsmpsAddonsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Optional add-on (you can also add it later from the Plugins dialog)"
  Pop $0
  ${NSD_CreateCheckbox} 0 30u 100% 52u "Download FFmpeg after install (enables ProRes-compatible export).$\r$\nGPL-3.0-or-later build, downloaded by RSMPS from github.com (Gyan Doshi's FFmpeg builds), about 110 MB, checksum-verified. RSMPS does not include FFmpeg; this installer downloads nothing."
  Pop $RsmpsFfmpegBox
  ${NSD_SetState} $RsmpsFfmpegBox ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd

Function RsmpsAddonsPageLeave
  ${NSD_GetState} $RsmpsFfmpegBox $RsmpsFfmpegWanted
FunctionEnd
!endif

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom RsmpsAddonsPageCreate RsmpsAddonsPageLeave
!macroend

!macro customInstall
  ${If} $RsmpsFfmpegWanted == ${BST_CHECKED}
    CreateDirectory "$APPDATA\RSMPS"
    FileOpen $0 "$APPDATA\RSMPS\addon-requests.json" w
    FileWrite $0 '{"ffmpeg":true}'
    FileClose $0
  ${EndIf}
!macroend
