//go:build !windows

package main

import "fmt"

func configureOwner() error {
	return fmt.Errorf("interactive owner setup is available only on Windows")
}
