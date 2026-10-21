//go:build windows

package reaper

// Start 在 Windows 平台为空实现
func Start() {}

// Pause 在 Windows 平台为空实现
func Pause() {}

// Resume 在 Windows 平台为空实现
func Resume() {}

// Reap 在 Windows 平台为空实现
func Reap() {}
