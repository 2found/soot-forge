package main

// Copied into standalone artifact writers. One persistent lock inode protects
// object+metadata commits and garbage collection across packs/processes.
// Never unlink it: kernel locks release on process death without stale claims.
import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

var errStoreBusy = errors.New("artifact store busy; no artifact mutation started")

func lockArtifactStore(root string) (func(), error) {
	if root == "" || !filepath.IsAbs(root) {
		return nil, fmt.Errorf("artifact store binding missing or not absolute")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(root, ".forge-artifacts.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("invalid artifact store lock")
	}
	deadline := time.Now().Add(time.Second)
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			f.Close()
			return nil, err
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, errStoreBusy
		}
		time.Sleep(10 * time.Millisecond)
	}
}
