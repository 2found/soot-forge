// soot-data-pool is an independently installed Pack executable. The pool
// itself is the importable datapool package; this file only wires the process.
package main

import (
	"os"

	"github.com/2found/soot-forge/packs/data-pool/runner/datapool"
)

func main() {
	os.Exit(datapool.Main(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, os.Getenv))
}
