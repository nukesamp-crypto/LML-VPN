; LML's own Radiance service is installed with the application; no Lantern UI is launched.
; Installer runs per-machine (administrator required); the daemon secures its data directory.
!macro customInstall
  ; Remove artifacts of the abandoned direct-config TUN experiment, if present.
  Delete "$INSTDIR\resources\bin\lml-tun-supervisor.exe"
  Delete "$INSTDIR\resources\bin\wintun.dll"
  DetailPrint "Preparing the LML Lantern service owner..."
  nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\resources\bin\lml-lanternd.exe" owner'
  Pop $0
  Pop $1
  ${If} $0 == "0"
    DetailPrint "Installing the LML Lantern service..."
    nsExec::ExecToStack /TIMEOUT=90000 '"$INSTDIR\resources\bin\lml-lanternd.exe" install'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "LML VPN was installed, but its internal Lantern service could not be installed. Psiphon remains available. Please check administrator permissions and reinstall." /SD IDOK
    ${EndIf}
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "LML VPN was installed, but the internal Lantern service could not be associated with the interactive user. Psiphon remains available. Please sign in to the desktop and reinstall with administrator permission." /SD IDOK
  ${EndIf}
!macroend

!macro customUnInstall
  ; Stop/delete only LML's own service, never the separately installed Lantern service.
  nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\sc.exe" query LMLLanternSvc'
  Pop $0
  Pop $1
  ${If} $0 == "0"
    nsExec::ExecToStack /TIMEOUT=90000 '"$INSTDIR\resources\bin\lml-lanternd.exe" uninstall'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "Could not remove the LML Lantern service. The uninstallation was stopped; try again as administrator." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  ${IfNot} ${isUpdated}
    SetRegView 64
    DeleteRegKey HKLM "Software\LMLVPN\LanternService"
  ${EndIf}
!macroend
