# Changelog

All notable changes to TinyTerm will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.18] - 2026-09-04

### Changed
- 移除顶部“凭据/主机”按钮组及拖拽区域
- 恢复 macOS / Windows 默认原生顶部标题栏框架
- Host 表单内 Credential 区域升级为可 CRUD 管理：新增“新增”按钮，每个选项提供编辑/删除按钮，以二级弹窗复用原凭证表单

## [1.0.8] - 2026-05-22

### Changed
- 辅助终端关闭按钮移除，统一由顶部拆分按钮控制
- 拆分按钮激活时显示绿色泛光效果
- 修复辅助终端关闭按钮与快捷指令按钮重叠问题

## [1.0.7] - 2026-05-22

### Fixed
- 同步更新 Tauri Rust crate 与 NPM 包版本，解决版本不匹配警告
- 调整窗口最小尺寸为 880×700

## [1.0.6] - 2026-05-22

### Added
- 终端快捷指令悬浮面板（CPU/内存/磁盘速查弹窗 + 55 条常用指令）
- 系统信息弹窗组件，支持表格展示、分页浏览
- 通过 `execute_remote_command` 在远程服务器上执行系统查询命令
- CPU/内存进程列表展示程序名称、执行路径及占用百分比
- 磁盘使用率超过 80% 时橙色高亮告警

## [1.0.5] - 2026-05-06

### Added
- 添加 Claude Code 项目助手指令配置文档

## [Unreleased]

### Added
- Initial project structure with Tauri + React
- SSH terminal emulation using xterm.js
- Multi-tab interface for managing connections
- Bookmark system for saving SSH connections
- File manager with SFTP support
- Dual terminal panels for side-by-side sessions
- Authentication profiles for credential management
- Settings management (fonts, themes, terminal preferences)
- Real-time file transfer progress monitoring
- Docker test environment for development

### Features
- **SSH Connections**: Support for password and private key authentication
- **Session Management**: Create, save, and organize SSH connections
- **File Transfers**: Drag-and-drop file upload/download via SFTP
- **UI/UX**: Modern interface with dark/light themes, collapsible sidebar
- **Cross-platform**: Windows, macOS, and Linux support

### Technical
- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Rust with Tauri framework
- **State Management**: Zustand for React state
- **Database**: SQLite for local data storage
- **Terminal**: xterm.js with fit and web-links addons
- **SSH Library**: ssh2-rs for Rust SSH implementation

## [0.1.0] - 2024-03-27

### Added
- Initial release of TinyTerm
- Basic SSH terminal functionality
- Connection bookmarking system
- File manager with basic SFTP operations
- Authentication profile management
- Application settings configuration
- Cross-platform build support

### Fixed
- Initial commit with working prototype

### Known Issues
- Some edge cases in file transfer error handling
- Limited keyboard shortcut customization
- Basic theme support (dark/light only)

---
**Note**: This is the initial release. Future versions will include more features and improvements based on user feedback.