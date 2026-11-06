// LML addition: authorize the interactive shell owner, not the elevated UAC approver.
// Copyright (C) 2026 LML VPN contributors; GPL-3.0-or-later.
package main

import (
	"fmt"
	"github.com/getlantern/radiance/common/serviceowner"
	"golang.org/x/sys/windows"
	"unsafe"
)

func configureOwner() error {
	user32 := windows.NewLazySystemDLL("user32.dll")
	shell, _, _ := user32.NewProc("GetShellWindow").Call()
	if shell == 0 {
		return fmt.Errorf("could not find interactive shell window")
	}
	var pid uint32
	user32.NewProc("GetWindowThreadProcessId").Call(shell, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return fmt.Errorf("could not determine interactive shell process")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("open interactive shell: %w", err)
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err = windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return fmt.Errorf("open interactive shell token: %w", err)
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return fmt.Errorf("read interactive user: %w", err)
	}
	if err = serviceowner.Save(user.User.Sid.String()); err != nil {
		return fmt.Errorf("save service owner: %w", err)
	}
	return nil
}
