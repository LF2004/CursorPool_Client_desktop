; electron-builder 会包含本文件（默认 build/installer.nsh）
; 解决：用户自选盘符/文件夹时未自动带上应用子目录、需手动新建文件夹的问题。
; 在安装进度页之前（选目录之后）规范化 $INSTDIR，并提前创建目录。

!macro customPageAfterChangeDir
  ; electron-builder 会在脚本顶层 !insertmacro customPageAfterChangeDir。
  ; 因此这里必须“定义 Function”，并通过 MUI_PAGE_CUSTOMFUNCTION_LEAVE 让目录页调用它。
  !ifndef MUI_PAGE_CUSTOMFUNCTION_LEAVE
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE customPageAfterChangeDir
  !endif

  Function customPageAfterChangeDir
    ; 若路径已以 "\${APP_FILENAME}" 结尾则不重复追加
    StrCpy $R8 "$INSTDIR\${APP_FILENAME}"
    StrLen $R0 "$INSTDIR"
    StrLen $R1 "\${APP_FILENAME}"
    IntOp $R2 $R0 - $R1
    IntCmp $R2 0 +2 0 +2
    StrCpy $R2 0
    StrCpy $R3 "$INSTDIR" $R1 $R2
    StrCmp $R3 "\${APP_FILENAME}" +2 0
    StrCpy $INSTDIR "$R8"
    CreateDirectory "$INSTDIR"
  FunctionEnd
!macroend

!macro customUnInstall
  DetailPrint "Cleaning CursorPool Relay certificates..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$items = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $$_.Subject -like ''*CursorPool Relay CA*'' -or ($$_.Subject -like ''*CursorPool*'' -and $$_.Subject -like ''*Relay CA*'') }; foreach ($$item in $$items) { Remove-Item -LiteralPath $$item.PSPath -Force -ErrorAction SilentlyContinue }; $$relayDir = Join-Path $$env:USERPROFILE ''.cursorpool\relay''; Remove-Item -LiteralPath $$relayDir -Recurse -Force -ErrorAction SilentlyContinue"'
!macroend
