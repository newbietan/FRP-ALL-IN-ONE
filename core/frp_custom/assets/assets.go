package assets

import (
	"io/fs"
	"net/http"
)

var FileSystem http.FileSystem = emptyFS{}

type emptyFS struct{}

func (emptyFS) Open(name string) (http.File, error) {
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

// Load 桩函数：纯净版内核无需加载任何静态资产
func Load(path string) {}
