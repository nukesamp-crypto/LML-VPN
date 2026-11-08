// LML VPN Lantern v10 local IPC bridge. GPL-3.0-or-later.
// Uses the upstream Radiance pipe, Identification-level SQOS, and verifies that
// its server is LML VPN’s bundled system service.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const pipePath = `\\.\pipe\LMLVPN\lantern`
const pipeAccess = 0x12019b

func expectedPath() string {
	directory, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil || directory == "" {
		directory = `C:\Program Files`
	}
	return filepath.Join(directory, "LML VPN", "LMLLanternSvc.exe")
}

var getServerPID = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetNamedPipeServerProcessId")
var allowed = map[string]bool{
	"GET /vpn/status": true, "POST /vpn/connect": true, "POST /vpn/disconnect": true,
	"GET /server/selected": true, "POST /server/selected": true, "GET /servers": true,
}

type Request struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Body   json.RawMessage `json:"body"`
}
type Response struct {
	Ok    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Code  int             `json:"code,omitempty"`
	Error string          `json:"error,omitempty"`
}

func fail(msg string) { _ = json.NewEncoder(os.Stdout).Encode(Response{Error: msg}); os.Exit(1) }
func authenticate(c net.Conn) error {
	f, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return fmt.Errorf("cannot inspect pipe")
	}
	var pid uint32
	r, _, e := getServerPID.Call(f.Fd(), uintptr(unsafe.Pointer(&pid)))
	if r == 0 || pid == 0 {
		return fmt.Errorf("cannot inspect pipe server: %v", e)
	}
	process, e2 := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if e2 != nil {
		return fmt.Errorf("cannot inspect service process")
	}
	defer windows.CloseHandle(process)
	// Lantern grants its owner limited process-query rights; token query may be
	// denied for non-admin users. Verify the SCM parent instead of requiring it.
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return fmt.Errorf("cannot query service manager")
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := syscall.UTF16PtrFromString("LMLLanternSvc")
	service, err := windows.OpenService(manager, name, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return fmt.Errorf("cannot query service")
	}
	defer windows.CloseServiceHandle(service)
	var status windows.SERVICE_STATUS_PROCESS
	var needed uint32
	if err = windows.QueryServiceStatusEx(service, windows.SC_STATUS_PROCESS_INFO, (*byte)(unsafe.Pointer(&status)), uint32(unsafe.Sizeof(status)), &needed); err != nil || status.CurrentState != windows.SERVICE_RUNNING || status.ProcessId == 0 {
		return fmt.Errorf("service not running")
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return fmt.Errorf("cannot inspect process parent")
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	parent := uint32(0)
	if err = windows.Process32First(snapshot, &entry); err == nil {
		for {
			if entry.ProcessID == pid {
				parent = entry.ParentProcessID
				break
			}
			if windows.Process32Next(snapshot, &entry) != nil {
				break
			}
		}
	}
	if parent != status.ProcessId {
		return fmt.Errorf("pipe server is not the service child")
	}
	buffer := make([]uint16, 32768)
	length := uint32(len(buffer))
	if e2 = windows.QueryFullProcessImageName(process, 0, &buffer[0], &length); e2 != nil {
		return fmt.Errorf("cannot inspect service path")
	}
	got := windows.UTF16ToString(buffer[:length])
	if !strings.EqualFold(filepath.Clean(got), filepath.Clean(expectedPath())) {
		return fmt.Errorf("unexpected service executable")
	}
	return nil
}
func main() {
	var in Request
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 1<<20)).Decode(&in); err != nil {
		fail("invalid request")
	}
	if !allowed[in.Method+" "+in.Path] {
		fail("unsupported request")
	}
	transport := newLanternTransport(func(ctx context.Context, _, _ string) (net.Conn, error) {
		c, err := winio.DialPipeAccessImpLevel(ctx, pipePath, pipeAccess, winio.PipeImpLevelIdentification)
		if err != nil {
			return nil, err
		}
		if err = authenticate(c); err != nil {
			c.Close()
			return nil, err
		}
		return c, nil
	})
	defer transport.CloseIdleConnections()
	timeout := 15 * time.Second
	if in.Path == "/vpn/connect" {
		timeout = 60 * time.Second
	}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	var body io.Reader
	if len(in.Body) > 0 && string(in.Body) != "null" {
		body = bytes.NewReader(in.Body)
	}
	req, err := http.NewRequest(in.Method, "http://pipe"+in.Path, body)
	if err != nil {
		fail("invalid request")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		fail("Lantern service unavailable or unverified")
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(io.LimitReader(resp.Body, 4_000_001))
	if err != nil || len(out) > 4_000_000 {
		fail("invalid response")
	}
	if resp.StatusCode >= 400 {
		_ = json.NewEncoder(os.Stdout).Encode(Response{Code: resp.StatusCode, Error: "service rejected request"})
		os.Exit(1)
	}
	if len(bytes.TrimSpace(out)) == 0 {
		out = []byte("null")
	}
	if !json.Valid(out) {
		fail("invalid service response")
	}
	_ = json.NewEncoder(os.Stdout).Encode(Response{Ok: true, Data: json.RawMessage(out)})
}
