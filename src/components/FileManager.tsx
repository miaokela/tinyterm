import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TransferProgress, FileInfo, SessionTab } from '../types'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  ChevronUp, ChevronDown, Folder, File as FileIcon2,
  RefreshCw, FolderPlus, Trash2, Pencil, HardDrive,
  ArrowRight, ArrowLeft, Monitor, Server, Eye, EyeOff, X,
} from 'lucide-react'

import { useStore } from '../store'
import ElectricBorder from './ElectricBorder'
import './FileManager.css'

interface Props {
  session: SessionTab
  bookmarkTabId: string
}

interface RemoteDeleteStatus {
  path: string
  is_dir: boolean
  success: boolean
  error?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function getFileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    txt: '#a0c0e0', md: '#a0c0e0', json: '#f5c842', js: '#f5c842',
    ts: '#4fc3f7', tsx: '#4fc3f7', jsx: '#4fc3f7', py: '#4caf8a',
    rs: '#f4732a', go: '#00bcd4', sh: '#70a0ff', bash: '#70a0ff',
    png: '#e57373', jpg: '#e57373', jpeg: '#e57373', gif: '#e57373',
    svg: '#ffb74d', zip: '#70a0ff', tar: '#70a0ff', gz: '#70a0ff',
    pdf: '#ef5350', html: '#ff8a65', css: '#42a5f5',
  }
  return map[ext] ?? '#7a7a9a'
}

function FileItemIcon({ isDir, name }: { isDir: boolean; name: string }) {
  if (isDir) return <Folder size={14} strokeWidth={1.6} className="fm-item-icon dir" />
  return <FileIcon2 size={14} strokeWidth={1.6} className="fm-item-icon file" style={{ color: getFileColor(name) }} />
}

// ── Context Menu ──────────────────────────────────────────────────────────────

interface CtxMenu { x: number; y: number; file: FileInfo; side: 'local' | 'remote' }
type InlineAction =
  | { type: 'rename'; side: 'local' | 'remote'; file: FileInfo; value: string }
  | { type: 'new-folder'; side: 'local' | 'remote'; value: string }

function getNormalizedPointerPosition(e: ReactMouseEvent) {
  const zoomValue = Number(getComputedStyle(document.documentElement).zoom || '1')
  const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1
  return {
    x: e.clientX / zoom,
    y: e.clientY / zoom,
  }
}

function ContextMenu({
  menu, onClose, onDelete, onRename, deleteLabel = '删除',
}: {
  menu: CtxMenu
  onClose: () => void
  onDelete: (f: FileInfo, side: 'local' | 'remote') => void
  onRename: (f: FileInfo, side: 'local' | 'remote') => void
  deleteLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: menu.x, y: menu.y })

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])

  // Clamp the menu inside the window so right-clicking a file near the bottom /
  // right edge doesn't push it off-screen. Runs before paint to avoid flicker.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    const zoomValue = Number(getComputedStyle(document.documentElement).zoom || '1')
    const zoom = Number.isFinite(zoomValue) && zoomValue > 0 ? zoomValue : 1
    const margin = 4
    const vw = window.innerWidth / zoom
    const vh = window.innerHeight / zoom
    const mw = rect.width / zoom
    const mh = rect.height / zoom
    const nextX = Math.min(menu.x, Math.max(margin, vw - mw - margin))
    const nextY = Math.min(menu.y, Math.max(margin, vh - mh - margin))
    setPosition({ x: nextX, y: nextY })
  }, [menu.x, menu.y])

  const menuNode = (
    <div
      ref={ref}
      className="fm-ctx-menu glass-panel"
      style={{ position: 'fixed', top: position.y, left: position.x, zIndex: 2000 }}
    >
      <div className="fm-ctx-item" onClick={() => { onRename(menu.file, menu.side); onClose() }}>
        <Pencil size={11} strokeWidth={1.8} /> 重命名
      </div>
      <div className="fm-ctx-divider" />
      <div className="fm-ctx-item danger" onClick={() => { onDelete(menu.file, menu.side); onClose() }}>
        <Trash2 size={11} strokeWidth={1.8} /> {deleteLabel}
      </div>
    </div>
  )

  return createPortal(menuNode, document.body)
}

// ── Single Panel ──────────────────────────────────────────────────────────────

interface PanelProps {
  side: 'local' | 'remote'
  title: string
  icon: React.ReactNode
  files: FileInfo[]
  currentPath: string
  loading: boolean
  error?: string
  selectedPaths: Set<string>
  onSelectionChange: (file: FileInfo, mode: 'single' | 'toggle' | 'range') => void
  onNavigate: (path: string) => void
  onGoUp: () => void
  onToggleHidden: () => void
  showHidden: boolean
  disabled?: boolean
  busyLabel?: string
  onRefresh: () => void
  onNewFolder: () => void
  onContextMenu: (e: React.MouseEvent, file: FileInfo) => void
  onNavigateStart?: () => void
}

function Panel({
  side, title, icon, files, currentPath, loading, error,
  selectedPaths, onSelectionChange, onNavigate, onGoUp, onToggleHidden, showHidden, disabled = false, busyLabel, onRefresh, onNewFolder, onContextMenu, onNavigateStart,
}: PanelProps) {
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState(currentPath)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editingPath) setPathInput(currentPath)
  }, [currentPath, editingPath])

  const commitPath = async () => {
    setEditingPath(false)
    if (pathInput !== currentPath) {
      onNavigateStart?.()
      // 强制先渲染 loading 状态
      await new Promise(resolve => setTimeout(resolve, 50))
      onNavigate(pathInput)
    }
  }

  return (
    <div className={`fm-panel fm-panel--${side}${disabled ? ' fm-panel--disabled' : ''}`}>
      {/* Panel header */}
      <div className="fm-panel-header">
        <span className="fm-panel-icon">{icon}</span>
        <span className="fm-panel-title">{title}</span>
        <div className="fm-panel-actions">
          <button
            className="fm-icon-btn"
            onClick={onToggleHidden}
            title={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
            disabled={disabled}
          >
            {showHidden
              ? <Eye size={13} strokeWidth={1.8} />
              : <EyeOff size={13} strokeWidth={1.8} />}
          </button>
          <button className="fm-icon-btn" onClick={onRefresh} title="刷新" disabled={disabled}>
            <RefreshCw size={13} strokeWidth={1.8} />
          </button>
          <button className="fm-icon-btn" onClick={onNewFolder} title="新建文件夹" disabled={disabled}>
            <FolderPlus size={13} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {/* Path bar */}
      <div className="fm-path-bar">
        <button className="fm-icon-btn fm-up-btn" onClick={onGoUp} title="上级目录" disabled={disabled}>
          <ChevronUp size={13} strokeWidth={2.2} />
        </button>
        {editingPath ? (
          <input
            ref={inputRef}
            className="fm-path-input"
            value={pathInput}
            onChange={e => setPathInput(e.target.value)}
            onBlur={commitPath}
            onKeyDown={e => {
              if (e.key === 'Enter') commitPath()
              if (e.key === 'Escape') { setEditingPath(false); setPathInput(currentPath) }
            }}
            disabled={disabled}
            autoFocus
          />
        ) : (
          <div
            className="fm-path-display"
            onClick={() => {
              if (disabled) return
              setEditingPath(true)
              setPathInput(currentPath)
            }}
            title={currentPath}
          >
            {currentPath}
          </div>
        )}
      </div>

      {/* File list */}
      <div className="fm-list">
        {loading ? (
          <div className="fm-status loading"><div className="fm-spinner" /></div>
        ) : error ? (
          <div className="fm-status error">{error}</div>
        ) : files.length === 0 ? (
          <div className="fm-status muted">空目录</div>
        ) : (
          files.map(file => {
            const isSelected = selectedPaths.has(file.path)
            return (
              <div
                key={file.path}
                className={`fm-item${isSelected ? ' fm-item--selected' : ''}`}
                onClick={e => {
                  if (disabled) return
                  if (e.shiftKey) onSelectionChange(file, 'range')
                  else if (e.metaKey || e.ctrlKey) onSelectionChange(file, 'toggle')
                  else onSelectionChange(file, 'single')
                }}
                onDoubleClick={async () => {
                  if (disabled) return
                  if (file.is_dir) {
                    onNavigateStart?.()
                    // 强制先渲染 loading 状态
                    await new Promise(resolve => setTimeout(resolve, 50))
                    onNavigate(file.path)
                  }
                }}
                onContextMenu={e => {
                  if (disabled) {
                    e.preventDefault()
                    e.stopPropagation()
                    return
                  }
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(e, file)
                }}
              >
                <FileItemIcon isDir={file.is_dir} name={file.name} />
                <span className="fm-item-name">{file.name}</span>
                {!file.is_dir && (
                  <span className="fm-item-size">{formatSize(file.size)}</span>
                )}
              </div>
            )
          })
        )}
      </div>

      {disabled && (
        <div className="fm-panel-overlay">
          <span>{busyLabel || '处理中...'}</span>
        </div>
      )}
    </div>
  )
}

// ── Transfer Queue ─────────────────────────────────────────────────────────────

interface ConfirmDialogAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'ghost'
}

interface TransferConflictState {
  transferId: string
  direction: 'upload' | 'download'
  fileName: string
  targetPath: string
  remainingPaths: string[]
  applyToAll: boolean
}

interface ConfirmDialogProps {
  title: string
  message: string
  onCancel: () => void
  actions?: ConfirmDialogAction[]
}

function ConfirmDialog({ title, message, onCancel, actions }: ConfirmDialogProps) {
  const resolvedActions = actions && actions.length > 0
    ? actions
    : [
        { label: '取消', onClick: onCancel, variant: 'ghost' as const },
      ]

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 3000 }}>
      <div className="cf-shell" onClick={e => e.stopPropagation()}>
        <div className="cm-header">
          <div className="cm-header-left">
            <span>{title}</span>
          </div>
        </div>
        <div className="cf-body">
          <p style={{ margin: 0, color: 'var(--color-text-primary)', whiteSpace: 'pre-line' }}>{message}</p>
        </div>
        <div className="cf-footer">
          <div className="cf-footer-group">
            {resolvedActions.map(action => (
              <button
                key={action.label}
                className={action.variant === 'ghost' ? 'btn-ghost' : 'btn-primary'}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function TransferQueue({ transfers, onCancel }: { transfers: TransferProgress[]; onCancel: (transferId: string) => void }) {
  // Group ALL transfers (including done ones) so we can count done items accurately
  const groups = new Map<string | undefined, TransferProgress[]>()
  for (const t of transfers) {
    const gid = t.group_id
    if (!groups.has(gid)) groups.set(gid, [])
    groups.get(gid)!.push(t)
  }

  // Only show groups that still have active (non-done) items
  const activeGroups = Array.from(groups.entries()).filter(([groupId, items]) => {
    if (!groupId) return items.some(t => t.status !== 'done')
    const subItems = items.filter(t => t.id !== groupId)
    return subItems.some(t => t.status !== 'done')
  })

  if (activeGroups.length === 0) return null

  return (
    <div className="fm-transfer-queue">
      {activeGroups.map(([groupId, items]) => {
        if (groupId) {
          // Batch group — single line with 3 regions
          // Use ALL sub-items (including done) for accurate counting
          const subItems = items.filter(t => t.id !== groupId)
          const transferring = subItems.find(t => t.status === 'transferring')
          const done = subItems.filter(t => t.status === 'done').length
          // 待传 = 总数 - 已完成 - 正在传的1个
          const pending = Math.max(0, subItems.length - done - (transferring ? 1 : 0))
          const hasError = subItems.some(t => t.status === 'error' || t.status === 'conflict')
          const current = transferring || subItems.find(t => t.status === 'pending') || subItems[0]

          const dir = current?.direction ?? 'upload'
          const currentPercent = current && current.total > 0
            ? Math.min(100, Math.round((current.transferred / current.total) * 100))
            : 0
          const overallPercent = subItems.length > 0
            ? Math.min(100, Math.round((done / subItems.length) * 100))
            : 0
          const showPercent = transferring ? currentPercent : overallPercent
          const actionLabel = dir === 'upload' ? '正在上传' : '正在下载'

          const isTransferring = !!transferring

          return (
            <ElectricBorder
              key={groupId}
              active={isTransferring}
              color={hasError ? '#e53935' : '#FFD700'}
              speed={1.2}
              chaos={0.08}
              borderRadius={6}
              offset={3}
              style={{ marginBottom: 4 }}
            >
            <div className="fm-tc-row">
              {/* Region 1: Currently transferring */}
              <div className="fm-tc-region fm-tc-region--active">
                <span className="fm-tc-dir">
                  {dir === 'upload'
                    ? <ArrowRight size={12} strokeWidth={2.5} />
                    : <ArrowLeft size={12} strokeWidth={2.5} />}
                </span>
                <span className="fm-tc-action">{actionLabel}:</span>
                <span className="fm-tc-filename" title={current?.file_name || ''}>
                  {current?.file_name || '...'}
                </span>
                <div className="fm-tc-track">
                  <div
                    className="fm-tc-fill"
                    style={{
                      width: `${showPercent}%`,
                      background: hasError ? 'rgba(220, 50, 50, 0.8)' : 'var(--color-accent)'
                    }}
                  />
                </div>
                <span className="fm-tc-pct">{showPercent}%</span>
              </div>

              {/* Region 2: Pending */}
              <div className="fm-tc-region fm-tc-region--pending">
                <span className="fm-tc-label">待传</span>
                <span className="fm-tc-count">{pending}</span>
              </div>

              {/* Region 3: Done */}
              <div className="fm-tc-region fm-tc-region--done">
                <span className="fm-tc-label">完成</span>
                <span className="fm-tc-count">{done}</span>
              </div>

              {/* Cancel */}
              <button
                className="fm-tc-cancel"
                onClick={() => items.forEach(t => onCancel(t.id))}
                title="全部取消"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
            </ElectricBorder>
          )
        }

        // Non-grouped items — single line with active region only
        return items.filter(t => t.status !== 'done').map(item => {
          const percent = item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0
          const isError = item.status === 'error' || item.status === 'conflict'
          const isActive = item.status === 'transferring'

          return (
            <ElectricBorder
              key={item.id}
              active={isActive}
              color={isError ? '#e53935' : '#FFD700'}
              speed={1.2}
              chaos={0.08}
              borderRadius={6}
              offset={3}
              style={{ marginBottom: 4 }}
            >
            <div className="fm-tc-row">
              <div className="fm-tc-region fm-tc-region--active">
                <span className="fm-tc-dir">
                  {item.direction === 'upload'
                    ? <ArrowRight size={12} strokeWidth={2.5} />
                    : <ArrowLeft size={12} strokeWidth={2.5} />}
                </span>
                <span className="fm-tc-filename" title={item.error ? `${item.file_name}\n${item.error}` : item.file_name}>
                  {item.file_name}
                </span>
                <div className="fm-tc-track">
                  <div
                    className="fm-tc-fill"
                    style={{
                      width: `${percent}%`,
                      background: isError ? 'rgba(220, 50, 50, 0.8)' : 'var(--color-accent)'
                    }}
                  />
                </div>
                <span className="fm-tc-pct">{percent}%</span>
              </div>

              {isError && (
                <span className="fm-tc-error" title={item.error || ''}>
                  {item.error === '用户取消' || item.error === 'Cancelled' ? '已取消' : '失败'}
                </span>
              )}

              {(item.status === 'pending' || item.status === 'transferring') && (
                <button
                  className="fm-tc-cancel"
                  onClick={() => onCancel(item.id)}
                  title="取消"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              )}
            </div>
            </ElectricBorder>
          )
        })
      })}
    </div>
  )
}

// ── Main FileManager ───────────────────────────────────────────────────────────

interface ConfirmState {
  title: string
  message: string
  actions: ConfirmDialogAction[]
}

export function FileManager({ session, bookmarkTabId }: Props) {
  // Local panel state
  const [localFiles, setLocalFiles] = useState<FileInfo[]>([])
  const [localPath, setLocalPath] = useState(session.localPath || '')
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [localDeleting, setLocalDeleting] = useState(false)

  // Remote panel state
  const [remoteFiles, setRemoteFiles] = useState<FileInfo[]>([])
  const [remotePath, setRemotePath] = useState(session.remotePath || '/')
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string>()
  const [remoteDeleting, setRemoteDeleting] = useState(false)

  // Hidden files toggle
  const [showLocalHidden, setShowLocalHidden] = useState(false)
  const [showRemoteHidden, setShowRemoteHidden] = useState(false)

  // Selection + drag state
  const [selectedLocalPaths, setSelectedLocalPaths] = useState<string[]>([])
  const [selectedRemotePaths, setSelectedRemotePaths] = useState<string[]>([])
  const [lastSelectedLocalPath, setLastSelectedLocalPath] = useState<string | null>(null)
  const [lastSelectedRemotePath, setLastSelectedRemotePath] = useState<string | null>(null)

  // Context menu / inline actions
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [inlineAction, setInlineAction] = useState<InlineAction | null>(null)

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null)
  const [transferConflict, setTransferConflict] = useState<TransferConflictState | null>(null)
  const [remoteTarSupport, setRemoteTarSupport] = useState<boolean | null>(null)
  const [remoteTarChecking, setRemoteTarChecking] = useState(false)

  const allTransfers = useStore(s => s.transfers)
  const transfers = useMemo(() => allTransfers.filter(t => t.session_id === session.id), [allTransfers, session.id])
  const updateTransfer = useStore(s => s.updateTransfer)
  const toggleFm = useStore(s => s.toggleFm)
  const updateSessionPath = useStore(s => s.updateSessionPath)
  const openConfirmDialog = useStore(s => s.openConfirmDialog)
  const openAlertDialog = useStore(s => s.openAlertDialog)
  const collapsed = !session.fmOpen

  // Track previous fmOpen to detect false→true edge
  const prevFmOpenRef = useRef<boolean>(!!session.fmOpen)

  // ── Load functions ────────────────────────────────────────────────────────

  const loadLocal = useCallback(async (path: string) => {
    if (!path) return
    setLocalLoading(true)
    setLocalError(undefined)
    try {
      const files = await invoke<FileInfo[]>('list_local_dir', { path })
      setLocalFiles(files)
      setLocalPath(path)
      setSelectedLocalPaths(prev => prev.filter(p => files.some(f => f.path === p)))
    } catch (e: any) {
      setLocalError(String(e))
    } finally {
      setLocalLoading(false)
    }
  }, [])

  const loadRemote = useCallback(async (path: string) => {
    if (!session.sessionId) return
    setRemoteLoading(true)
    setRemoteError(undefined)
    try {
      const files = await invoke<FileInfo[]>('list_remote_dir', { sessionId: session.sessionId, path })
      setRemoteFiles(files)
      setRemotePath(path)
      setSelectedRemotePaths(prev => prev.filter(p => files.some(f => f.path === p)))
    } catch (e: any) {
      const errMsg = String(e)
      const isNoSuchFile = /no such file|SFTP\(2\)/i.test(errMsg)

      if (isNoSuchFile && path !== '/') {
        // The tracked path doesn't exist on the remote — walk up to the
        // nearest existing parent, then fall back to home / root.
        const parent = path.replace(/\/[^/]+\/?$/, '') || '/'
        if (parent !== path) {
          // Try the parent directory first (recursive — will keep walking up)
          setRemoteLoading(false)
          return loadRemote(parent)
        }

        // Parent is also "/" and that failed — try fetching home via backend
        try {
          const home = await invoke<string>('get_remote_cwd', { sessionId: session.sessionId })
          if (home && home !== path) {
            setRemoteLoading(false)
            return loadRemote(home)
          }
        } catch { /* ignore */ }

        // Last resort: try "/"
        if (path !== '/') {
          setRemoteLoading(false)
          return loadRemote('/')
        }
      }

      setRemoteError(errMsg)
    } finally {
      setRemoteLoading(false)
    }
  }, [session.sessionId])

  // Prime panel-level loading state before the first paint after expand so
  // the shell opens immediately and each side renders its own loading state.
  useLayoutEffect(() => {
    if (!!session.fmOpen && !prevFmOpenRef.current) {
      setLocalLoading(true)
      if (session.sessionId && session.status === 'connected') {
        setRemoteLoading(true)
      }
    }
  }, [session.fmOpen, session.sessionId, session.status])

  // Load when file manager is opened — triggers every time fmOpen goes false→true
  useEffect(() => {
    const isOpen = !!session.fmOpen
    const wasOpen = prevFmOpenRef.current
    prevFmOpenRef.current = isOpen

    if (!isOpen) {
      return
    }

    // Only act on the rising edge (closed → opened)
    if (wasOpen) return

    // 强制先让 loading 状态渲染到 UI 上
    const timeoutId = setTimeout(() => {
      const localPromise = localPath
        ? loadLocal(localPath)
        : import('@tauri-apps/api/path').then(m => m.homeDir()).then(h => loadLocal(h)).catch(() => loadLocal('/'))

      let remotePromise: Promise<unknown> = Promise.resolve()

      // Remote panel — two-phase open:
      //
      // Phase 1 (instant): load the last-known path immediately so the panel
      //   shows content right away with no blank loading screen.
      //
      // Phase 2 (background): ask the backend for the *real* pwd via an exec
      //   channel reading /proc/<pid>/cwd of the live PTY shell.  If the real
      //   pwd differs from what we already loaded, navigate there automatically.
      //   This corrects timing gaps in client-side cd tracking (e.g. a "cd"
      //   done within the first 800 ms before get_remote_cwd initialised
      //   homePathRef, or any cd the tracker simply missed).
      if (session.sessionId && session.status === 'connected') {
        const knownPath = session.terminalPath || remotePath || '/'
        remotePromise = loadRemote(knownPath)
          .then(() => invoke<string>('get_remote_cwd', { sessionId: session.sessionId }))
          .then(realCwd => {
            if (!realCwd) return
            updateSessionPath(bookmarkTabId, session.id, realCwd)
            if (realCwd !== knownPath) {
              return loadRemote(realCwd)
            }
          })
          .catch(() => { /* non-Linux or exec failed — phase 1 result is fine */ })
      }

      Promise.allSettled([localPromise, remotePromise]).catch(() => {})
    }, 50)

    return () => clearTimeout(timeoutId)
  }, [session.fmOpen])

  // Live-follow: when the file manager is already open and the user cds in the
  // terminal, navigate the remote panel to the new directory automatically.
  // (The on-open sync above already handles the "just expanded" case via
  // get_remote_cwd, so this is only for navigation while FM stays open.)
  useEffect(() => {
    if (!session.terminalPath || collapsed || !session.sessionId) return
    if (session.terminalPath !== remotePath) {
      loadRemote(session.terminalPath)
    }
  }, [session.terminalPath])

  // ── Navigation helpers ────────────────────────────────────────────────────

  const goLocalUp = async () => {
    const parts = localPath.replace(/\/$/, '').split('/')
    setLocalLoading(true)
    // 强制先渲染 loading 状态
    await new Promise(resolve => setTimeout(resolve, 50))
    loadLocal(parts.slice(0, -1).join('/') || '/')
  }

  const goRemoteUp = async () => {
    const parts = remotePath.replace(/\/$/, '').split('/')
    setRemoteLoading(true)
    // 强制先渲染 loading 状态
    await new Promise(resolve => setTimeout(resolve, 50))
    loadRemote(parts.slice(0, -1).join('/') || '/')
  }

  const joinPath = (dir: string, name: string) =>
    `${dir.replace(/\/$/, '')}/${name}`

  const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

  const ensureRemoteTarSupport = useCallback(async (): Promise<boolean> => {
    if (!session.sessionId) return false
    if (remoteTarSupport !== null) return remoteTarSupport

    setRemoteTarChecking(true)
    try {
      const output = await invoke<string>('execute_remote_command', {
        sessionId: session.sessionId,
        command: "command -v tar >/dev/null 2>&1 && printf '__TINYTERM_TAR_OK__' || true",
      })
      const supported = output.includes('__TINYTERM_TAR_OK__')
      setRemoteTarSupport(supported)
      return supported
    } catch {
      setRemoteTarSupport(false)
      return false
    } finally {
      setRemoteTarChecking(false)
    }
  }, [session.sessionId, remoteTarSupport])

  useEffect(() => {
    setRemoteTarSupport(null)
    setRemoteTarChecking(false)
  }, [session.sessionId])

  useEffect(() => {
    if (!session.fmOpen || !session.sessionId || session.status !== 'connected') return
    if (remoteTarSupport !== null || remoteTarChecking) return
    ensureRemoteTarSupport().catch(() => {})
  }, [session.fmOpen, session.sessionId, session.status, remoteTarSupport, remoteTarChecking, ensureRemoteTarSupport])

  const selectedLocalPathSet = useMemo(() => new Set(selectedLocalPaths), [selectedLocalPaths])
  const selectedRemotePathSet = useMemo(() => new Set(selectedRemotePaths), [selectedRemotePaths])

  const visibleLocalFiles = useMemo(
    () => showLocalHidden ? localFiles : localFiles.filter(file => !file.name.startsWith('.')),
    [localFiles, showLocalHidden],
  )
  const visibleRemoteFiles = useMemo(
    () => showRemoteHidden ? remoteFiles : remoteFiles.filter(file => !file.name.startsWith('.')),
    [remoteFiles, showRemoteHidden],
  )

  const updateSelection = (
    files: FileInfo[],
    target: FileInfo,
    mode: 'single' | 'toggle' | 'range',
    selectedPaths: string[],
    setSelectedPaths: React.Dispatch<React.SetStateAction<string[]>>,
    lastSelectedPath: string | null,
    setLastSelectedPath: React.Dispatch<React.SetStateAction<string | null>>,
  ) => {
    if (mode === 'single') {
      setSelectedPaths([target.path])
      setLastSelectedPath(target.path)
      return
    }

    if (mode === 'toggle') {
      setSelectedPaths(prev => (
        prev.includes(target.path)
          ? prev.filter(path => path !== target.path)
          : [...prev, target.path]
      ))
      setLastSelectedPath(target.path)
      return
    }

    const anchorPath = lastSelectedPath ?? selectedPaths[selectedPaths.length - 1] ?? target.path
    const anchorIndex = files.findIndex(file => file.path === anchorPath)
    const targetIndex = files.findIndex(file => file.path === target.path)
    if (anchorIndex === -1 || targetIndex === -1) {
      setSelectedPaths([target.path])
      setLastSelectedPath(target.path)
      return
    }
    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
    setSelectedPaths(files.slice(start, end + 1).map(file => file.path))
    setLastSelectedPath(target.path)
  }

  const handleLocalSelectionChange = (file: FileInfo, mode: 'single' | 'toggle' | 'range') => {
    updateSelection(
      visibleLocalFiles,
      file,
      mode,
      selectedLocalPaths,
      setSelectedLocalPaths,
      lastSelectedLocalPath,
      setLastSelectedLocalPath,
    )
  }

  const handleRemoteSelectionChange = (file: FileInfo, mode: 'single' | 'toggle' | 'range') => {
    updateSelection(
      visibleRemoteFiles,
      file,
      mode,
      selectedRemotePaths,
      setSelectedRemotePaths,
      lastSelectedRemotePath,
      setLastSelectedRemotePath,
    )
  }

  // ── Upload (local → remote) ───────────────────────────────────────────────

  type TransferTaskOptions = {
    transferId?: string
    displayName?: string
    progressTotal?: number
    progressStart?: number
    progressSpan?: number
    displayTargetPath?: string
    sessionId?: string
    groupId?: string
  }

  const startTransferTask = useCallback((
    direction: 'upload' | 'download',
    sourcePath: string,
    targetPath: string,
    overwrite = false,
    options?: TransferTaskOptions,
  ): Promise<{ transferId: string, fileName: string, conflict: boolean, error?: string }> => {
    return new Promise((resolve) => {
      const fileName = options?.displayName ?? sourcePath.split('/').pop() ?? 'file'
      const transferId = options?.transferId ?? `${direction}:${targetPath}`
      const displayTargetPath = options?.displayTargetPath ?? targetPath
      const progressTotal = options?.progressTotal ?? 0
      const progressStart = options?.progressStart ?? 0

      updateTransfer({
        id: transferId,
        file_name: fileName,
        direction,
        total: progressTotal,
        transferred: progressStart,
        status: 'pending',
        target_path: displayTargetPath,
        session_id: options?.sessionId,
        group_id: options?.groupId,
      })

      const unlistenPromise = listen('transfer-progress', (event) => {
        const progress = event.payload as TransferProgress
        if (progress.id !== transferId) return

        if (progress.status === 'done') {
          unlistenPromise.then(unlisten => unlisten())
          resolve({ transferId, fileName, conflict: false })
        } else if (progress.status === 'conflict') {
          unlistenPromise.then(unlisten => unlisten())
          resolve({ transferId, fileName, conflict: true })
        } else if (progress.status === 'error') {
          unlistenPromise.then(unlisten => unlisten())
          resolve({ transferId, fileName, conflict: false, error: progress.error })
        }
      })

      const invokePromise = direction === 'upload'
        ? invoke('upload_file', {
            sessionId: session.sessionId,
            localPath: sourcePath,
            remotePath: targetPath,
            overwrite,
            transferId: options?.transferId,
            displayName: options?.displayName,
            progressTotal: options?.progressTotal,
            progressStart: options?.progressStart,
            progressSpan: options?.progressSpan,
            targetPathOverride: options?.displayTargetPath,
          })
        : invoke('download_file', {
            sessionId: session.sessionId,
            remotePath: sourcePath,
            localPath: targetPath,
            overwrite,
            transferId: options?.transferId,
            displayName: options?.displayName,
            progressTotal: options?.progressTotal,
            progressStart: options?.progressStart,
            progressSpan: options?.progressSpan,
            targetPathOverride: options?.displayTargetPath,
          })

      invokePromise.catch((e) => {
        unlistenPromise.then(unlisten => unlisten())
        const message = String(e)
        if (message.includes('CONFLICT:')) {
          updateTransfer({
            id: transferId,
            file_name: fileName,
            direction,
            total: 0,
            transferred: 0,
            status: 'conflict',
            error: message,
            target_path: displayTargetPath,
            conflict_path: displayTargetPath,
            session_id: options?.sessionId,
            group_id: options?.groupId,
          })
          resolve({ transferId, fileName, conflict: true })
        } else {
          updateTransfer({
            id: transferId,
            file_name: fileName,
            direction,
            total: 0,
            transferred: 0,
            status: 'error',
            error: message,
            target_path: displayTargetPath,
            session_id: options?.sessionId,
            group_id: options?.groupId,
          })
          resolve({ transferId, fileName, conflict: false, error: message })
        }
      })
    })
  }, [session.sessionId, updateTransfer])

  const runUploadQueue = useCallback(async (
    localFilePaths: string[],
    targetRemoteDir: string,
    startIndex = 0,
    overwriteAll = false,
    groupId?: string,
  ) => {
    if (!session.sessionId || localFilePaths.length === 0) return

    const ownGroup = !groupId && localFilePaths.length > 1
    const batchGroupId = groupId || (ownGroup ? `batch-upload:${session.id}:${Date.now()}` : undefined)

    if (startIndex === 0) {
      if (batchGroupId && ownGroup) {
        updateTransfer({
          id: batchGroupId,
          file_name: `上传 ${localFilePaths.length} 项`,
          direction: 'upload',
          total: localFilePaths.length,
          transferred: 0,
          status: 'pending',
          target_path: targetRemoteDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
      localFilePaths.forEach(p => {
        const fn = p.split('/').pop() ?? 'file'
        const target = joinPath(targetRemoteDir, fn)
        updateTransfer({
          id: `upload:${target}`, file_name: fn, direction: 'upload',
          total: 0, transferred: 0, status: 'pending', target_path: target,
          session_id: session.id, group_id: batchGroupId,
        })
      })
    }

    let hasError = false
    for (let index = startIndex; index < localFilePaths.length; index += 1) {
      const localFilePath = localFilePaths[index]
      const fileName = localFilePath.split('/').pop() ?? 'file'
      const remoteTarget = joinPath(targetRemoteDir, fileName)
      const transferId = `upload:${remoteTarget}`

      if (useStore.getState().transfers.find(t => t.id === transferId)?.status === 'error') {
        continue // Skip if cancelled
      }

      const result = await startTransferTask('upload', localFilePath, remoteTarget, overwriteAll, {
        sessionId: session.id,
        groupId: batchGroupId,
      })
      if (result.conflict) {
        hasError = true
        setTransferConflict({
          transferId: result.transferId,
          direction: 'upload',
          fileName,
          targetPath: remoteTarget,
          remainingPaths: localFilePaths.slice(index),
          applyToAll: false,
        })
        return
      }
      if (result.error) {
        hasError = true
      }

      if (ownGroup && batchGroupId) {
        const current = useStore.getState().transfers.find(t => t.id === batchGroupId)
        if (current && current.status !== 'error') {
          updateTransfer({
            id: batchGroupId,
            file_name: current.file_name,
            direction: 'upload',
            total: localFilePaths.length,
            transferred: index + 1,
            status: 'transferring',
            target_path: targetRemoteDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
      }
    }

    if (ownGroup && batchGroupId) {
      const current = useStore.getState().transfers.find(t => t.id === batchGroupId)
      if (current) {
        updateTransfer({
          id: batchGroupId,
          file_name: current.file_name,
          direction: 'upload',
          total: localFilePaths.length,
          transferred: localFilePaths.length,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetRemoteDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
    }

    await loadRemote(targetRemoteDir)
  }, [session.sessionId, session.id, startTransferTask, loadRemote, updateTransfer])

  const runDownloadQueue = useCallback(async (
    remoteFilePaths: string[],
    targetLocalDir: string,
    startIndex = 0,
    overwriteAll = false,
    groupId?: string,
  ) => {
    if (!session.sessionId || remoteFilePaths.length === 0) return

    const ownGroup = !groupId && remoteFilePaths.length > 1
    const batchGroupId = groupId || (ownGroup ? `batch-download:${session.id}:${Date.now()}` : undefined)

    if (startIndex === 0) {
      if (batchGroupId && ownGroup) {
        updateTransfer({
          id: batchGroupId,
          file_name: `下载 ${remoteFilePaths.length} 项`,
          direction: 'download',
          total: remoteFilePaths.length,
          transferred: 0,
          status: 'pending',
          target_path: targetLocalDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
      remoteFilePaths.forEach(p => {
        const fn = p.split('/').pop() ?? 'file'
        const target = joinPath(targetLocalDir, fn)
        updateTransfer({
          id: `download:${target}`, file_name: fn, direction: 'download',
          total: 0, transferred: 0, status: 'pending', target_path: target,
          session_id: session.id, group_id: batchGroupId,
        })
      })
    }

    let hasError = false
    for (let index = startIndex; index < remoteFilePaths.length; index += 1) {
      const remoteFilePath = remoteFilePaths[index]
      const fileName = remoteFilePath.split('/').pop() ?? 'file'
      const localTarget = joinPath(targetLocalDir, fileName)
      const transferId = `download:${localTarget}`

      if (useStore.getState().transfers.find(t => t.id === transferId)?.status === 'error') {
        continue // Skip if cancelled
      }

      const result = await startTransferTask('download', remoteFilePath, localTarget, overwriteAll, {
        sessionId: session.id,
        groupId: batchGroupId,
      })
      if (result.conflict) {
        hasError = true
        setTransferConflict({
          transferId: result.transferId,
          direction: 'download',
          fileName,
          targetPath: localTarget,
          remainingPaths: remoteFilePaths.slice(index),
          applyToAll: false,
        })
        return
      }
      if (result.error) {
        hasError = true
      }

      if (ownGroup && batchGroupId) {
        const current = useStore.getState().transfers.find(t => t.id === batchGroupId)
        if (current && current.status !== 'error') {
          updateTransfer({
            id: batchGroupId,
            file_name: current.file_name,
            direction: 'download',
            total: remoteFilePaths.length,
            transferred: index + 1,
            status: 'transferring',
            target_path: targetLocalDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
      }
    }

    if (ownGroup && batchGroupId) {
      const current = useStore.getState().transfers.find(t => t.id === batchGroupId)
      if (current) {
        updateTransfer({
          id: batchGroupId,
          file_name: current.file_name,
          direction: 'download',
          total: remoteFilePaths.length,
          transferred: remoteFilePaths.length,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetLocalDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
    }

    await loadLocal(targetLocalDir)
  }, [session.sessionId, session.id, startTransferTask, loadLocal, updateTransfer])

  const waitForStageProgress = useCallback((
    transferId: string,
    expectedProgress: number,
    start: () => Promise<unknown>,
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      let settled = false
      let unlistenFn: null | (() => void) = null

      const finish = (handler: () => void) => {
        if (settled) return
        settled = true
        if (unlistenFn) unlistenFn()
        handler()
      }

      const unlistenPromise = listen<TransferProgress>('transfer-progress', event => {
        const progress = event.payload
        if (progress.id !== transferId) return

        if (progress.status === 'error') {
          finish(() => reject(new Error(progress.error || '阶段任务失败')))
          return
        }

        if ((progress.transferred ?? 0) >= expectedProgress) {
          finish(() => resolve())
        }
      })

      unlistenPromise.then(unlisten => {
        unlistenFn = unlisten
      }).catch(error => {
        finish(() => reject(error))
      })

      start().catch(error => {
        finish(() => reject(error))
      })
    })
  }, [])

  const collectLocalUploadTasks = useCallback(async (
    sourceDir: string,
    targetRemoteDir: string,
  ): Promise<Array<{ localPath: string; remotePath: string }>> => {
    if (!session.sessionId) return []
    const entries = await invoke<FileInfo[]>('list_local_dir', { path: sourceDir })
    const tasks: Array<{ localPath: string; remotePath: string }> = []

    for (const entry of entries) {
      const remoteEntryPath = joinPath(targetRemoteDir, entry.name)
      if (entry.is_dir) {
        await invoke('create_remote_dir', {
          sessionId: session.sessionId,
          path: remoteEntryPath,
        }).catch(() => {})
        const nested = await collectLocalUploadTasks(entry.path, remoteEntryPath)
        tasks.push(...nested)
      } else {
        tasks.push({ localPath: entry.path, remotePath: remoteEntryPath })
      }
    }

    return tasks
  }, [session.sessionId, joinPath])

  const collectRemoteDownloadTasks = useCallback(async (
    sourceRemoteDir: string,
    targetLocalDir: string,
  ): Promise<Array<{ remotePath: string; localPath: string }>> => {
    if (!session.sessionId) return []

    const base = sourceRemoteDir.replace(/\/$/, '') || '/'
    const files = await invoke<FileInfo[]>('scan_remote_folder', {
      sessionId: session.sessionId,
      path: sourceRemoteDir,
    })

    return files.map(file => {
      const relative = file.path.startsWith(`${base}/`)
        ? file.path.slice(base.length + 1)
        : file.name
      return {
        remotePath: file.path,
        localPath: joinPath(targetLocalDir, relative),
      }
    })
  }, [session.sessionId, joinPath])

  const doUpload = useCallback(async (localItems: FileInfo[], targetRemoteDir: string, overwriteAll = false) => {
    if (!session.sessionId) return

    const batchGroupId = localItems.length > 1 ? `batch-upload:${session.id}:${Date.now()}` : undefined
    let completedCount = 0
    let hasError = false

    if (batchGroupId) {
      updateTransfer({
        id: batchGroupId,
        file_name: `上传 ${localItems.length} 项`,
        direction: 'upload',
        total: localItems.length,
        transferred: 0,
        status: 'pending',
        target_path: targetRemoteDir,
        session_id: session.id,
        group_id: batchGroupId,
      })
    }

    const canUseTar = await ensureRemoteTarSupport()

    // Fallback path: recursive SFTP upload when remote tar is unavailable.
    if (!canUseTar) {
      const folderItems = localItems.filter(i => i.is_dir)
      const fileItems = localItems.filter(i => !i.is_dir)

      // Pre-create all folder transfer records so the batch group stays visible
      for (const folder of folderItems) {
        const remoteTarget = joinPath(targetRemoteDir, folder.name)
        const transferId = `upload:${remoteTarget}`
        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'upload',
          total: 1,
          transferred: 0,
          status: 'pending',
          target_path: remoteTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }

      for (const folder of folderItems) {
        const remoteTarget = joinPath(targetRemoteDir, folder.name)
        const transferId = `upload:${remoteTarget}`

        try {
          await invoke('create_remote_dir', {
            sessionId: session.sessionId,
            path: remoteTarget,
          }).catch(() => {})

          const tasks = await collectLocalUploadTasks(folder.path, remoteTarget)
          if (tasks.length === 0) {
            updateTransfer({
              id: transferId,
              file_name: folder.name,
              direction: 'upload',
              total: 1,
              transferred: 1,
              status: 'done',
              target_path: remoteTarget,
              session_id: session.id,
              group_id: batchGroupId,
            })
            completedCount += 1
            if (batchGroupId) {
              updateTransfer({
                id: batchGroupId,
                file_name: `上传 ${localItems.length} 项`,
                direction: 'upload',
                total: localItems.length,
                transferred: completedCount,
                status: completedCount >= localItems.length ? 'done' : 'transferring',
                target_path: targetRemoteDir,
                session_id: session.id,
                group_id: batchGroupId,
              })
            }
            continue
          }

          for (let index = 0; index < tasks.length; index += 1) {
            const task = tasks[index]
            const result = await startTransferTask('upload', task.localPath, task.remotePath, overwriteAll, {
              transferId,
              displayName: folder.name,
              progressTotal: tasks.length,
              progressStart: index,
              displayTargetPath: remoteTarget,
              sessionId: session.id,
              groupId: batchGroupId,
            })

            if (result.error) {
              throw new Error(result.error)
            }

            if (result.conflict && !overwriteAll) {
              updateTransfer({
                id: transferId,
                file_name: folder.name,
                direction: 'upload',
                total: tasks.length,
                transferred: index,
                status: 'error',
                error: '存在同名文件，已跳过冲突项。可重试并选择全部覆盖。',
                target_path: remoteTarget,
                session_id: session.id,
                group_id: batchGroupId,
              })
              break
            }
          }

          const final = useStore.getState().transfers.find(t => t.id === transferId)
          if (final?.status !== 'error') {
            updateTransfer({
              id: transferId,
              file_name: folder.name,
              direction: 'upload',
              total: tasks.length,
              transferred: tasks.length,
              status: 'done',
              target_path: remoteTarget,
              session_id: session.id,
              group_id: batchGroupId,
            })
          } else {
            hasError = true
          }
        } catch (e) {
          hasError = true
          updateTransfer({
            id: transferId,
            file_name: folder.name,
            direction: 'upload',
            total: 1,
            transferred: 0,
            status: 'error',
            error: String(e),
            target_path: remoteTarget,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }

        completedCount += 1
        if (batchGroupId) {
          updateTransfer({
            id: batchGroupId,
            file_name: `上传 ${localItems.length} 项`,
            direction: 'upload',
            total: localItems.length,
            transferred: completedCount,
            status: completedCount >= localItems.length ? 'done' : 'transferring',
            target_path: targetRemoteDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
      }

      if (fileItems.length > 0) {
        if (batchGroupId) {
          await runUploadQueue(fileItems.map(i => i.path), targetRemoteDir, 0, overwriteAll, batchGroupId)
          completedCount += fileItems.length
          updateTransfer({
            id: batchGroupId,
            file_name: `上传 ${localItems.length} 项`,
            direction: 'upload',
            total: localItems.length,
            transferred: completedCount,
            status: hasError ? 'error' : 'done',
            error: hasError ? '部分文件传输失败' : undefined,
            target_path: targetRemoteDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        } else {
          await runUploadQueue(fileItems.map(i => i.path), targetRemoteDir, 0, overwriteAll)
        }
      } else {
        if (batchGroupId) {
          updateTransfer({
            id: batchGroupId,
            file_name: `上传 ${localItems.length} 项`,
            direction: 'upload',
            total: localItems.length,
            transferred: completedCount,
            status: hasError ? 'error' : 'done',
            error: hasError ? '部分文件传输失败' : undefined,
            target_path: targetRemoteDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
        await loadRemote(targetRemoteDir)
      }
      return
    }

    const { tempDir } = await import('@tauri-apps/api/path')
    const localTmpDir = await tempDir()

    const folderItems = localItems.filter(i => i.is_dir)
    const fileItems = localItems.filter(i => !i.is_dir)

    // Pre-create all folder transfer records so the batch group stays visible
    for (const folder of folderItems) {
      const remoteTarget = joinPath(targetRemoteDir, folder.name)
      const transferId = `upload:${remoteTarget}`
      updateTransfer({
        id: transferId,
        file_name: folder.name,
        direction: 'upload',
        total: 100,
        transferred: 0,
        transferred_bytes: 0,
        status: 'pending',
        target_path: remoteTarget,
        session_id: session.id,
        group_id: batchGroupId,
      })
    }

    for (const folder of folderItems) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const localSubTmp = joinPath(localTmpDir, `tinyterm-pack-${stamp}`)
      const tmpTarLocal = joinPath(localSubTmp, '.tinyterm-pack.tar')
      const tmpTarRemote = joinPath(targetRemoteDir, `.tinyterm-pack-${stamp}.tar`)
      const remoteTarget = joinPath(targetRemoteDir, folder.name)
      const transferId = `upload:${remoteTarget}`

      try {
        await invoke('create_local_dir', { path: localSubTmp })

        await waitForStageProgress(transferId, 20, () => invoke('pack_local_dir', {
          sourceDir: folder.path,
          targetTarPath: tmpTarLocal,
          transferId,
          displayName: folder.name,
          direction: 'upload',
          progressTotal: 100,
          progressStart: 0,
          progressSpan: 20,
          targetPath: remoteTarget,
        }))

        const result = await startTransferTask('upload', tmpTarLocal, tmpTarRemote, true, {
          transferId,
          displayName: folder.name,
          progressTotal: 100,
          progressStart: 20,
          progressSpan: 60,
          displayTargetPath: remoteTarget,
          sessionId: session.id,
          groupId: batchGroupId,
        })
        if (result.error) throw new Error(result.error)

        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'upload',
          total: 100,
          transferred: 90,
          status: 'transferring',
          target_path: remoteTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })

        if (overwriteAll) {
          try {
            await invoke('delete_remote', { sessionId: session.sessionId, path: remoteTarget, isDir: true })
          } catch (e) {
            console.warn('Failed to delete remote folder before unpack:', e)
          }
        }

        const tarCmd = overwriteAll
          ? `mkdir -p ${shellQuote(targetRemoteDir)} && tar -xf ${shellQuote(tmpTarRemote)} -C ${shellQuote(targetRemoteDir)}`
          : `mkdir -p ${shellQuote(targetRemoteDir)} && tar -k -xf ${shellQuote(tmpTarRemote)} -C ${shellQuote(targetRemoteDir)}`

        await invoke('execute_remote_command', {
          sessionId: session.sessionId,
          command: tarCmd,
        })

        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'upload',
          total: 100,
          transferred: 100,
          status: 'done',
          target_path: remoteTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } catch (e) {
        hasError = true
        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'upload',
          total: 100,
          transferred: 0,
          status: 'error',
          error: String(e),
          target_path: remoteTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } finally {
        await invoke('execute_remote_command', {
          sessionId: session.sessionId,
          command: `rm -f ${shellQuote(tmpTarRemote)}`,
        }).catch(() => {})
        await invoke('delete_local', { path: tmpTarLocal, isDir: false }).catch(() => {})
        await invoke('delete_local', { path: localSubTmp, isDir: true }).catch(() => {})
      }

      completedCount += 1
      if (batchGroupId) {
        updateTransfer({
          id: batchGroupId,
          file_name: `上传 ${localItems.length} 项`,
          direction: 'upload',
          total: localItems.length,
          transferred: completedCount,
          status: completedCount >= localItems.length ? 'done' : 'transferring',
          target_path: targetRemoteDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
    }

    if (fileItems.length > 0) {
      if (batchGroupId) {
        await runUploadQueue(fileItems.map(i => i.path), targetRemoteDir, 0, overwriteAll, batchGroupId)
        completedCount += fileItems.length
        updateTransfer({
          id: batchGroupId,
          file_name: `上传 ${localItems.length} 项`,
          direction: 'upload',
          total: localItems.length,
          transferred: completedCount,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetRemoteDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } else {
        await runUploadQueue(fileItems.map(i => i.path), targetRemoteDir, 0, overwriteAll)
      }
    } else {
      if (batchGroupId) {
        updateTransfer({
          id: batchGroupId,
          file_name: `上传 ${localItems.length} 项`,
          direction: 'upload',
          total: localItems.length,
          transferred: completedCount,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetRemoteDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
      await loadRemote(targetRemoteDir)
    }
  }, [session.sessionId, session.id, ensureRemoteTarSupport, collectLocalUploadTasks, joinPath, updateTransfer, startTransferTask, runUploadQueue, loadRemote, shellQuote, waitForStageProgress])

  // ── Download (remote → local) ─────────────────────────────────────────────

  const doDownload = useCallback(async (remoteItems: FileInfo[], targetLocalDir: string, overwriteAll = false) => {
    if (!session.sessionId) return

    const batchGroupId = remoteItems.length > 1 ? `batch-download:${session.id}:${Date.now()}` : undefined
    let completedCount = 0
    let hasError = false

    if (batchGroupId) {
      updateTransfer({
        id: batchGroupId,
        file_name: `下载 ${remoteItems.length} 项`,
        direction: 'download',
        total: remoteItems.length,
        transferred: 0,
        status: 'pending',
        target_path: targetLocalDir,
        session_id: session.id,
        group_id: batchGroupId,
      })
    }

    const canUseTar = await ensureRemoteTarSupport()

    // Fallback path: recursive SFTP download when remote tar is unavailable.
    if (!canUseTar) {
      const folderItems = remoteItems.filter(i => i.is_dir)
      const fileItems = remoteItems.filter(i => !i.is_dir)

      // Pre-create all folder transfer records so the batch group stays visible
      for (const folder of folderItems) {
        const localTarget = joinPath(targetLocalDir, folder.name)
        const transferId = `download:${localTarget}`
        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'download',
          total: 1,
          transferred: 0,
          status: 'pending',
          target_path: localTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }

      for (const folder of folderItems) {
        const localTarget = joinPath(targetLocalDir, folder.name)
        const transferId = `download:${localTarget}`

        try {
          await invoke('create_local_dir', { path: localTarget }).catch(() => {})

          const tasks = await collectRemoteDownloadTasks(folder.path, localTarget)
          if (tasks.length === 0) {
            updateTransfer({
              id: transferId,
              file_name: folder.name,
              direction: 'download',
              total: 1,
              transferred: 1,
              status: 'done',
              target_path: localTarget,
              session_id: session.id,
              group_id: batchGroupId,
            })
            completedCount += 1
            if (batchGroupId) {
              updateTransfer({
                id: batchGroupId,
                file_name: `下载 ${remoteItems.length} 项`,
                direction: 'download',
                total: remoteItems.length,
                transferred: completedCount,
                status: completedCount >= remoteItems.length ? 'done' : 'transferring',
                target_path: targetLocalDir,
                session_id: session.id,
                group_id: batchGroupId,
              })
            }
            continue
          }

          for (let index = 0; index < tasks.length; index += 1) {
            const task = tasks[index]
            const parent = task.localPath.slice(0, task.localPath.lastIndexOf('/'))
            if (parent) {
              await invoke('create_local_dir', { path: parent }).catch(() => {})
            }

            const result = await startTransferTask('download', task.remotePath, task.localPath, overwriteAll, {
              transferId,
              displayName: folder.name,
              progressTotal: tasks.length,
              progressStart: index,
              displayTargetPath: localTarget,
              sessionId: session.id,
              groupId: batchGroupId,
            })

            if (result.error) {
              throw new Error(result.error)
            }

            if (result.conflict && !overwriteAll) {
              updateTransfer({
                id: transferId,
                file_name: folder.name,
                direction: 'download',
                total: tasks.length,
                transferred: index,
                status: 'error',
                error: '存在同名文件，已跳过冲突项。可重试并选择全部覆盖。',
                target_path: localTarget,
                session_id: session.id,
                group_id: batchGroupId,
              })
              break
            }
          }

          const final = useStore.getState().transfers.find(t => t.id === transferId)
          if (final?.status !== 'error') {
            updateTransfer({
              id: transferId,
              file_name: folder.name,
              direction: 'download',
              total: tasks.length,
              transferred: tasks.length,
              status: 'done',
              target_path: localTarget,
              session_id: session.id,
              group_id: batchGroupId,
            })
          } else {
            hasError = true
          }
        } catch (e) {
          hasError = true
          updateTransfer({
            id: transferId,
            file_name: folder.name,
            direction: 'download',
            total: 1,
            transferred: 0,
            status: 'error',
            error: String(e),
            target_path: localTarget,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }

        completedCount += 1
        if (batchGroupId) {
          updateTransfer({
            id: batchGroupId,
            file_name: `下载 ${remoteItems.length} 项`,
            direction: 'download',
            total: remoteItems.length,
            transferred: completedCount,
            status: completedCount >= remoteItems.length ? 'done' : 'transferring',
            target_path: targetLocalDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
      }

      if (fileItems.length > 0) {
        if (batchGroupId) {
          await runDownloadQueue(fileItems.map(i => i.path), targetLocalDir, 0, overwriteAll, batchGroupId)
          completedCount += fileItems.length
          updateTransfer({
            id: batchGroupId,
            file_name: `下载 ${remoteItems.length} 项`,
            direction: 'download',
            total: remoteItems.length,
            transferred: completedCount,
            status: hasError ? 'error' : 'done',
            error: hasError ? '部分文件传输失败' : undefined,
            target_path: targetLocalDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        } else {
          await runDownloadQueue(fileItems.map(i => i.path), targetLocalDir, 0, overwriteAll)
        }
      } else {
        if (batchGroupId) {
          updateTransfer({
            id: batchGroupId,
            file_name: `下载 ${remoteItems.length} 项`,
            direction: 'download',
            total: remoteItems.length,
            transferred: completedCount,
            status: hasError ? 'error' : 'done',
            error: hasError ? '部分文件传输失败' : undefined,
            target_path: targetLocalDir,
            session_id: session.id,
            group_id: batchGroupId,
          })
        }
        await loadLocal(targetLocalDir)
      }
      return
    }

    const { tempDir } = await import('@tauri-apps/api/path')
    const localTmpDir = await tempDir()

    const folderItems = remoteItems.filter(i => i.is_dir)
    const fileItems = remoteItems.filter(i => !i.is_dir)

    // Pre-create all folder transfer records so the batch group stays visible
    for (const folder of folderItems) {
      const localTarget = joinPath(targetLocalDir, folder.name)
      const transferId = `download:${localTarget}`
      updateTransfer({
        id: transferId,
        file_name: folder.name,
        direction: 'download',
        total: 100,
        transferred: 0,
        transferred_bytes: 0,
        status: 'pending',
        target_path: localTarget,
        session_id: session.id,
        group_id: batchGroupId,
      })
    }

    for (const folder of folderItems) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const localSubTmp = joinPath(localTmpDir, `tinyterm-pack-${stamp}`)
      const tmpTarLocal = joinPath(localSubTmp, '.tinyterm-pack.tar')
      const remoteParent = folder.path.substring(0, folder.path.lastIndexOf('/')) || '/'
      const tmpTarRemote = joinPath(remoteParent, `.tinyterm-pack-${stamp}.tar`)
      const localTarget = joinPath(targetLocalDir, folder.name)
      const transferId = `download:${localTarget}`

      try {
        await invoke('create_local_dir', { path: localSubTmp })

        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'download',
          total: 100,
          transferred: 10,
          status: 'transferring',
          target_path: localTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })

        const packCmd = `tar -cf ${shellQuote(tmpTarRemote)} -C ${shellQuote(remoteParent)} ${shellQuote(folder.name)}`
        await invoke('execute_remote_command', {
          sessionId: session.sessionId,
          command: packCmd,
        })

        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'download',
          total: 100,
          transferred: 20,
          status: 'transferring',
          target_path: localTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })

        const result = await startTransferTask('download', tmpTarRemote, tmpTarLocal, true, {
          transferId,
          displayName: folder.name,
          progressTotal: 100,
          progressStart: 20,
          progressSpan: 60,
          displayTargetPath: localTarget,
          sessionId: session.id,
          groupId: batchGroupId,
        })
        if (result.error) throw new Error(result.error)

        if (overwriteAll) {
          try {
            await invoke('delete_local', { path: localTarget, isDir: true })
          } catch (e) {
            console.warn('Failed to delete local folder before unpack:', e)
          }
        }

        await waitForStageProgress(transferId, 100, () => invoke('unpack_local_dir', {
          tarPath: tmpTarLocal,
          targetDir: targetLocalDir,
          overwrite: overwriteAll,
          transferId,
          displayName: folder.name,
          direction: 'download',
          progressTotal: 100,
          progressStart: 80,
          progressSpan: 20,
          targetPath: localTarget,
        }))

        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'download',
          total: 100,
          transferred: 100,
          status: 'done',
          target_path: localTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } catch (e) {
        hasError = true
        updateTransfer({
          id: transferId,
          file_name: folder.name,
          direction: 'download',
          total: 100,
          transferred: 0,
          status: 'error',
          error: String(e),
          target_path: localTarget,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } finally {
        await invoke('execute_remote_command', {
          sessionId: session.sessionId,
          command: `rm -f ${shellQuote(tmpTarRemote)}`,
        }).catch(() => {})
        await invoke('delete_local', { path: tmpTarLocal, isDir: false }).catch(() => {})
        await invoke('delete_local', { path: localSubTmp, isDir: true }).catch(() => {})
      }

      completedCount += 1
      if (batchGroupId) {
        updateTransfer({
          id: batchGroupId,
          file_name: `下载 ${remoteItems.length} 项`,
          direction: 'download',
          total: remoteItems.length,
          transferred: completedCount,
          status: completedCount >= remoteItems.length ? 'done' : 'transferring',
          target_path: targetLocalDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
    }

    if (fileItems.length > 0) {
      if (batchGroupId) {
        await runDownloadQueue(fileItems.map(i => i.path), targetLocalDir, 0, overwriteAll, batchGroupId)
        completedCount += fileItems.length
        updateTransfer({
          id: batchGroupId,
          file_name: `下载 ${remoteItems.length} 项`,
          direction: 'download',
          total: remoteItems.length,
          transferred: completedCount,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetLocalDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      } else {
        await runDownloadQueue(fileItems.map(i => i.path), targetLocalDir, 0, overwriteAll)
      }
    } else {
      if (batchGroupId) {
        updateTransfer({
          id: batchGroupId,
          file_name: `下载 ${remoteItems.length} 项`,
          direction: 'download',
          total: remoteItems.length,
          transferred: completedCount,
          status: hasError ? 'error' : 'done',
          error: hasError ? '部分文件传输失败' : undefined,
          target_path: targetLocalDir,
          session_id: session.id,
          group_id: batchGroupId,
        })
      }
      await loadLocal(targetLocalDir)
    }
  }, [session.sessionId, session.id, ensureRemoteTarSupport, collectRemoteDownloadTasks, joinPath, updateTransfer, startTransferTask, runDownloadQueue, loadLocal, shellQuote, waitForStageProgress])

  // ── Arrow button transfers ────────────────────────────────────────────────

  const selectedLocalTransferItems = visibleLocalFiles
    .filter(item => selectedLocalPathSet.has(item.path))

  // Include both files AND directories so folders can be downloaded
  const selectedRemoteItems = visibleRemoteFiles
    .filter(item => selectedRemotePathSet.has(item.path))

  const handleTransferToRemote = async () => {
    if (localDeleting || remoteDeleting) return

    if (selectedLocalTransferItems.length === 0) {
      await openAlertDialog({
        title: '上传提示',
        message: '请先在本地面板选择要上传的文件或文件夹',
      })
      return
    }

    const folderConflicts = selectedLocalTransferItems.filter(localItem =>
      localItem.is_dir && visibleRemoteFiles.some(remoteItem => remoteItem.name === localItem.name)
    )

    if (folderConflicts.length > 0) {
      const conflictNames = folderConflicts.map(c => c.name).join(', ')
      setConfirmDialog({
        title: '文件夹合并/覆盖确认',
        message: `目标目录中已存在 ${folderConflicts.length} 个同名文件夹（如：${conflictNames.slice(0, 50)}${conflictNames.length > 50 ? '...' : ''}）。\n继续上传将合并目录。若遇到同名文件，请选择处理方式：`,
        actions: [
          {
            label: '取消',
            variant: 'ghost',
            onClick: () => setConfirmDialog(null),
          },
          {
            label: '跳过现有文件',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doUpload(selectedLocalTransferItems, remotePath, false)
            },
          },
          {
            label: '全部覆盖',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doUpload(selectedLocalTransferItems, remotePath, true)
            },
          },
        ],
      })
      return
    }

    const fileConflicts = selectedLocalTransferItems.filter(localItem =>
      !localItem.is_dir && visibleRemoteFiles.some(remoteItem => remoteItem.name === localItem.name)
    )

    if (fileConflicts.length > 0) {
      const conflictNames = fileConflicts.map(c => c.name).join(', ')
      setConfirmDialog({
        title: '文件覆盖确认',
        message: `目标目录中已存在 ${fileConflicts.length} 个同名文件（如：${conflictNames.slice(0, 50)}${conflictNames.length > 50 ? '...' : ''}）。\n请选择处理方式：`,
        actions: [
          {
            label: '取消',
            variant: 'ghost',
            onClick: () => setConfirmDialog(null),
          },
          {
            label: '逐个询问',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doUpload(selectedLocalTransferItems, remotePath, false)
            },
          },
          {
            label: '全部覆盖',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doUpload(selectedLocalTransferItems, remotePath, true)
            },
          },
        ],
      })
      return
    }

    const itemCount = selectedLocalTransferItems.length
    const itemNames = selectedLocalTransferItems.map(p => p.name).join(', ')
    const hasFolder = selectedLocalTransferItems.some(i => i.is_dir)
    const typeLabel = hasFolder ? '个项目' : '个文件'
    setConfirmDialog({
      title: '确认上传',
      message: `确定上传 ${itemCount} ${typeLabel}到远程目录？\n${itemNames.length > 100 ? itemNames.slice(0, 100) + '...' : itemNames}`,
      actions: [
        {
          label: '取消',
          variant: 'ghost',
          onClick: () => setConfirmDialog(null),
        },
        {
          label: '开始上传',
          variant: 'primary',
          onClick: () => {
            setConfirmDialog(null)
            void doUpload(selectedLocalTransferItems, remotePath, false)
          },
        },
      ],
    })
  }

  const handleTransferToLocal = async () => {
    if (localDeleting || remoteDeleting) return

    if (selectedRemoteItems.length === 0) {
      await openAlertDialog({
        title: '下载提示',
        message: '请先在远程面板选择要下载的文件或文件夹',
      })
      return
    }

    const folderConflicts = selectedRemoteItems.filter(remoteItem =>
      remoteItem.is_dir && visibleLocalFiles.some(localItem => localItem.name === remoteItem.name)
    )

    if (folderConflicts.length > 0) {
      const conflictNames = folderConflicts.map(c => c.name).join(', ')
      setConfirmDialog({
        title: '文件夹合并/覆盖确认',
        message: `目标目录中已存在 ${folderConflicts.length} 个同名文件夹（如：${conflictNames.slice(0, 50)}${conflictNames.length > 50 ? '...' : ''}）。\n继续下载将合并目录。若遇到同名文件，请选择处理方式：`,
        actions: [
          {
            label: '取消',
            variant: 'ghost',
            onClick: () => setConfirmDialog(null),
          },
          {
            label: '跳过现有文件',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doDownload(selectedRemoteItems, localPath, false)
            },
          },
          {
            label: '全部覆盖',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doDownload(selectedRemoteItems, localPath, true)
            },
          },
        ],
      })
      return
    }

    const fileConflicts = selectedRemoteItems.filter(remoteItem =>
      !remoteItem.is_dir && visibleLocalFiles.some(localItem => localItem.name === remoteItem.name)
    )

    if (fileConflicts.length > 0) {
      // For files, we can also offer an upfront 'overwrite all' to save time, or let it fall through to the individual queue
      const conflictNames = fileConflicts.map(c => c.name).join(', ')
      setConfirmDialog({
        title: '文件覆盖确认',
        message: `目标目录中已存在 ${fileConflicts.length} 个同名文件（如：${conflictNames.slice(0, 50)}${conflictNames.length > 50 ? '...' : ''}）。\n请选择处理方式：`,
        actions: [
          {
            label: '取消',
            variant: 'ghost',
            onClick: () => setConfirmDialog(null),
          },
          {
            label: '逐个询问',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doDownload(selectedRemoteItems, localPath, false)
            },
          },
          {
            label: '全部覆盖',
            variant: 'primary',
            onClick: () => {
              setConfirmDialog(null)
              void doDownload(selectedRemoteItems, localPath, true)
            },
          },
        ],
      })
      return
    }

    const itemCount = selectedRemoteItems.length
    const itemNames = selectedRemoteItems.map(p => p.name).join(', ')
    const hasFolder = selectedRemoteItems.some(i => i.is_dir)
    const typeLabel = hasFolder ? '个项目' : '个文件'
    setConfirmDialog({
      title: '确认下载',
      message: `确定下载 ${itemCount} ${typeLabel}到本地目录？\n${itemNames.length > 100 ? itemNames.slice(0, 100) + '...' : itemNames}`,
      actions: [
        {
          label: '取消',
          variant: 'ghost',
          onClick: () => setConfirmDialog(null),
        },
        {
          label: '开始下载',
          variant: 'primary',
          onClick: () => {
            setConfirmDialog(null)
            void doDownload(selectedRemoteItems, localPath, false)
          },
        },
      ],
    })
  }

  const handleCancelTransfer = async (transferId: string) => {
    const activeTransfer = transfers.find(t => t.id === transferId)
    if (!activeTransfer) return

    try {
      await invoke('cancel_transfer', { transferId })
    } catch (e) {
      console.warn('Failed to cancel transfer on backend:', e)
    }

    updateTransfer({
      id: transferId,
      file_name: activeTransfer.file_name,
      direction: activeTransfer.direction,
      total: activeTransfer.total ?? 0,
      transferred: activeTransfer.transferred ?? 0,
      status: 'error',
      error: '用户取消',
      target_path: activeTransfer.target_path,
      session_id: activeTransfer.session_id,
      group_id: activeTransfer.group_id,
    })

    // Remove the transfer after 2 seconds based on user request "点击取消，隔2秒就消失"
    setTimeout(() => {
      updateTransfer({
        id: transferId,
        file_name: activeTransfer.file_name,
        direction: activeTransfer.direction,
        total: activeTransfer.total ?? 0,
        transferred: activeTransfer.transferred ?? 0,
        status: 'done',
        session_id: activeTransfer.session_id,
        group_id: activeTransfer.group_id,
      })
    }, 2000)
  }

  const handleConflictSkip = async () => {
    if (!transferConflict) return

    updateTransfer({
      id: transferConflict.transferId,
      file_name: transferConflict.fileName,
      direction: transferConflict.direction,
      total: 0,
      transferred: 0,
      status: 'error',
      error: '已跳过',
      target_path: transferConflict.targetPath,
      conflict_path: transferConflict.targetPath,
    })

    const remaining = transferConflict.remainingPaths.slice(1)
    const direction = transferConflict.direction
    const targetPath = transferConflict.targetPath
    setTransferConflict(null)

    if (remaining.length === 0) {
      if (direction === 'upload') await loadRemote(remotePath)
      else await loadLocal(localPath)
      return
    }

    if (direction === 'upload') {
      await runUploadQueue(remaining, remotePath)
    } else {
      await runDownloadQueue(remaining, localPath)
    }

    if (targetPath) {
      if (direction === 'upload') await loadRemote(remotePath)
      else await loadLocal(localPath)
    }
  }

  const handleConflictOverwrite = async () => {
    if (!transferConflict) return

    const { direction, remainingPaths, targetPath } = transferConflict
    // remainingPaths[0] is the source of the conflicted file
    const sourcePath = remainingPaths[0]
    const remaining = remainingPaths.slice(1)

    setTransferConflict(null)

    // Re-run the same transfer with overwrite=true — backend will skip conflict check
    await startTransferTask(direction, sourcePath, targetPath, true, {
      sessionId: session.id,
    })

    if (remaining.length === 0) {
      if (direction === 'upload') await loadRemote(remotePath)
      else await loadLocal(localPath)
      return
    }

    if (direction === 'upload') {
      await runUploadQueue(remaining, remotePath)
    } else {
      await runDownloadQueue(remaining, localPath)
    }
  }

  // ── CRUD operations ───────────────────────────────────────────────────────

  const handleDelete = async (file: FileInfo, side: 'local' | 'remote') => {
    if (side === 'local' ? localDeleting : remoteDeleting) return

    const selectedPaths = side === 'local' ? selectedLocalPaths : selectedRemotePaths
    const visibleFiles = side === 'local' ? visibleLocalFiles : visibleRemoteFiles
    const selectedSet = new Set(selectedPaths)
    const selectedItems = selectedSet.has(file.path)
      ? visibleFiles.filter(item => selectedSet.has(item.path))
      : [file]

    const label = selectedItems.length === 1
      ? `"${selectedItems[0].name}"`
      : `${selectedItems.length} 项`

    const confirmed = await openConfirmDialog({
      title: '删除确认',
      message: `确认删除 ${label} ?`,
      confirmText: '删除',
      cancelText: '取消',
    })
    if (!confirmed) return

    try {
      if (side === 'local') setLocalDeleting(true)
      else setRemoteDeleting(true)

      const waitForRemoteDelete = (path: string, isDir: boolean) => new Promise<void>((resolve, reject) => {
        let settled = false
        let unlistenFn: null | (() => void) = null

        const finish = (handler: () => void) => {
          if (settled) return
          settled = true
          if (unlistenFn) unlistenFn()
          handler()
        }

        const unlistenPromise = listen<RemoteDeleteStatus>('remote-delete-status', event => {
          const payload = event.payload
          if (payload.path !== path || payload.is_dir !== isDir) return

          if (payload.success) {
            finish(() => resolve())
          } else {
            finish(() => reject(new Error(payload.error || '远端删除失败')))
          }
        })

        unlistenPromise.then(unlisten => {
          unlistenFn = unlisten
        }).catch(error => finish(() => reject(error)))

        invoke('delete_remote_async', { sessionId: session.sessionId, path, isDir })
          .catch(error => finish(() => reject(error)))
      })

      for (const item of selectedItems) {
        if (side === 'local') {
          await invoke('delete_local', { path: item.path, isDir: item.is_dir })
        } else {
          await waitForRemoteDelete(item.path, item.is_dir)
        }
      }

      if (side === 'local') {
        setSelectedLocalPaths([])
        setLastSelectedLocalPath(null)
        loadLocal(localPath)
      } else {
        setSelectedRemotePaths([])
        setLastSelectedRemotePath(null)
        loadRemote(remotePath)
      }
    } catch (e) {
      await openAlertDialog({
        title: '删除失败',
        message: String(e),
      })
    }
    finally {
      if (side === 'local') setLocalDeleting(false)
      else setRemoteDeleting(false)
    }
  }

  const handleRename = async (file: FileInfo, side: 'local' | 'remote') => {
    setCtxMenu(null)
    setInlineAction({ type: 'rename', side, file, value: file.name })
  }

  const handleNewFolder = async (side: 'local' | 'remote') => {
    if ((side === 'local' && localDeleting) || (side === 'remote' && remoteDeleting)) return

    setCtxMenu(null)
    setInlineAction({ type: 'new-folder', side, value: '' })
  }

  const cancelInlineAction = () => setInlineAction(null)

  const submitInlineAction = async () => {
    if (!inlineAction) return

    const rawValue = inlineAction.value.trim()
    if (!rawValue) {
      await openAlertDialog({
        title: inlineAction.type === 'rename' ? '重命名提示' : '新建目录提示',
        message: inlineAction.type === 'rename' ? '请输入新名称' : '请输入文件夹名称',
      })
      return
    }

    try {
      if (inlineAction.type === 'rename') {
        const { file, side } = inlineAction
        if (rawValue === file.name) {
          setInlineAction(null)
          return
        }
        const dir = file.path.substring(0, file.path.lastIndexOf('/') + 1)
        const newPath = dir + rawValue

        if (side === 'local') {
          await invoke('rename_local', { oldPath: file.path, newPath })
          setInlineAction(null)
          loadLocal(localPath)
        } else {
          await invoke('rename_remote', { sessionId: session.sessionId, oldPath: file.path, newPath })
          setInlineAction(null)
          loadRemote(remotePath)
        }
        return
      }

      if (inlineAction.side === 'local') {
        await invoke('create_local_dir', { path: joinPath(localPath, rawValue) })
        setInlineAction(null)
        loadLocal(localPath)
      } else {
        await invoke('create_remote_dir', { sessionId: session.sessionId, path: joinPath(remotePath, rawValue) })
        setInlineAction(null)
        loadRemote(remotePath)
      }
    } catch (e) {
      await openAlertDialog({
        title: inlineAction.type === 'rename' ? '重命名失败' : '创建失败',
        message: String(e),
      })
    }
  }

  const handleInlineActionKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitInlineAction()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelInlineAction()
    }
  }

  // ── Collapse bar ──────────────────────────────────────────────────────────

  const activeTransfers = transfers.filter(t => t.status !== 'done')
  const uploadBusy = transfers.some(t => t.direction === 'upload' && (t.status === 'pending' || t.status === 'transferring' || t.status === 'conflict'))
  const downloadBusy = transfers.some(t => t.direction === 'download' && (t.status === 'pending' || t.status === 'transferring' || t.status === 'conflict'))

  return (
    <div
      className={`fm-root${collapsed ? ' fm-root--collapsed' : ''}`}
      onClick={() => {
        if (ctxMenu) setCtxMenu(null)
      }}
    >
      {/* Expanded content — rendered BEFORE bar in DOM so column-reverse puts it above */}
      {!collapsed && (
        <div className="fm-content glass-panel">
          {/* Transfer queue */}
          <TransferQueue transfers={transfers} onCancel={handleCancelTransfer} />

          {/* Dual panels */}
          <div className="fm-panels">
            {/* Left — Local */}
            <Panel
              side="local"
              title="本地"
              icon={<Monitor size={13} strokeWidth={1.8} />}
              files={visibleLocalFiles}
              currentPath={localPath}
              loading={localLoading}
              error={localError}
              selectedPaths={selectedLocalPathSet}
              disabled={localDeleting}
              busyLabel="删除中..."
              onSelectionChange={handleLocalSelectionChange}
              onNavigate={loadLocal}
              onGoUp={goLocalUp}
              onToggleHidden={() => setShowLocalHidden(v => !v)}
              showHidden={showLocalHidden}
              onRefresh={() => loadLocal(localPath)}
              onNewFolder={() => handleNewFolder('local')}
              onContextMenu={(e, file) => {
                const pos = getNormalizedPointerPosition(e)
                setCtxMenu({ x: pos.x, y: pos.y, file, side: 'local' })
              }}
              onNavigateStart={() => setLocalLoading(true)}
            />

            {/* Center divider */}
            <div className="fm-divider">
              <div className="fm-divider-line" />
              <div className="fm-divider-arrows">
                <button
                  className={`fm-transfer-btn${uploadBusy ? ' is-loading' : ''}${selectedLocalPaths.length > 0 ? ' is-active' : ''}`}
                  onClick={handleTransferToRemote}
                  title={uploadBusy ? '上传中...' : selectedLocalPaths.length > 0 ? `上传 ${selectedLocalPaths.length} 项到远程` : '上传选中文件到远程当前目录'}
                  type="button"
                  disabled={localDeleting || remoteDeleting || uploadBusy}
                >
                  {uploadBusy
                    ? <span className="fm-transfer-spinner" />
                    : (
                      <>
                        <ArrowRight size={12} strokeWidth={2} className="fm-divider-icon" />
                        {selectedLocalPaths.length > 0 && (
                          <span className="fm-transfer-badge fm-transfer-badge--left">{selectedLocalPaths.length}</span>
                        )}
                      </>
                    )}
                </button>
                <button
                  className={`fm-transfer-btn${downloadBusy ? ' is-loading' : ''}${selectedRemotePaths.length > 0 ? ' is-active' : ''}`}
                  onClick={handleTransferToLocal}
                  title={downloadBusy ? '下载中...' : selectedRemotePaths.length > 0 ? `下载 ${selectedRemotePaths.length} 项到本地` : '下载选中文件到本地当前目录'}
                  type="button"
                  disabled={localDeleting || remoteDeleting || downloadBusy}
                >
                  {downloadBusy
                    ? <span className="fm-transfer-spinner" />
                    : (
                      <>
                        <ArrowLeft size={12} strokeWidth={2} className="fm-divider-icon" />
                        {selectedRemotePaths.length > 0 && (
                          <span className="fm-transfer-badge fm-transfer-badge--right">{selectedRemotePaths.length}</span>
                        )}
                      </>
                    )}
                </button>
              </div>
              <div className="fm-divider-line" />
            </div>

            {/* Right — Remote */}
            <Panel
              side="remote"
              title="远程"
              icon={<Server size={13} strokeWidth={1.8} />}
              files={visibleRemoteFiles}
              currentPath={remotePath}
              loading={remoteLoading}
              error={remoteError}
              selectedPaths={selectedRemotePathSet}
              disabled={remoteDeleting}
              busyLabel="删除中..."
              onSelectionChange={handleRemoteSelectionChange}
              onNavigate={loadRemote}
              onGoUp={goRemoteUp}
              onToggleHidden={() => setShowRemoteHidden(v => !v)}
              showHidden={showRemoteHidden}
              onRefresh={() => loadRemote(remotePath)}
              onNewFolder={() => handleNewFolder('remote')}
              onContextMenu={(e, file) => {
                const pos = getNormalizedPointerPosition(e)
                setCtxMenu({ x: pos.x, y: pos.y, file, side: 'remote' })
              }}
              onNavigateStart={() => setRemoteLoading(true)}
            />
          </div>
        </div>
      )}

      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          actions={confirmDialog.actions}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {transferConflict && (
        <ConfirmDialog
          title="检测到同名目标"
          message={`目标中已存在同名项：${transferConflict.fileName}\n${transferConflict.targetPath}\n\n请选择如何处理当前冲突项。`}
          actions={[
            {
              label: '取消剩余传输',
              variant: 'ghost',
              onClick: () => {
                setTransferConflict(null)
              },
            },
            {
              label: '跳过当前项',
              variant: 'primary',
              onClick: () => {
                void handleConflictSkip()
              },
            },
            {
              label: '覆盖当前项',
              variant: 'primary',
              onClick: () => { void handleConflictOverwrite() },
            },
          ]}
          onCancel={() => setTransferConflict(null)}
        />
      )}

      {inlineAction && (
        <div className="modal-overlay" style={{ zIndex: 2100 }}>
          <div className="cf-shell" onClick={e => e.stopPropagation()}>
            <div className="cm-header">
              <div className="cm-header-left">
                <span>
                  {inlineAction.type === 'rename'
                    ? `重命名${inlineAction.file.is_dir ? '文件夹' : '文件'}`
                    : '新建文件夹'}
                </span>
              </div>
            </div>
            <div className="cf-body">
              <div className="cf-field full">
                <label className="cf-label">
                  {inlineAction.type === 'rename' ? '名称' : '文件夹名称'}
                </label>
                <input
                  className="form-input"
                  value={inlineAction.value}
                  onChange={e => setInlineAction(action => action ? { ...action, value: e.target.value } : action)}
                  onKeyDown={handleInlineActionKeyDown}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
              </div>
            </div>
            <div className="cf-footer">
              <div className="app-dialog-btn-group">
                <button className="btn-ghost" onClick={cancelInlineAction}>取消</button>
                <button className="btn-primary" onClick={submitInlineAction}>
                  {inlineAction.type === 'rename' ? '确定重命名' : '创建'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Collapse handle — sits at the bottom due to column-reverse */}
      <div className="fm-bar" onClick={() => toggleFm(bookmarkTabId, session.id)}>
        {collapsed
          ? <ChevronDown size={12} strokeWidth={2.2} className="fm-bar-arrow" />
          : <ChevronUp size={12} strokeWidth={2.2} className="fm-bar-arrow" />}
        <HardDrive size={12} strokeWidth={1.8} className="fm-bar-icon" />
        <span className="fm-bar-title">文件管理</span>
        {activeTransfers.length > 0 && (
          <span className="fm-bar-badge">{activeTransfers.length}</span>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onDelete={handleDelete}
          onRename={handleRename}
          deleteLabel={
            (() => {
              const selectedPaths = ctxMenu.side === 'local' ? selectedLocalPaths : selectedRemotePaths
              const count = selectedPaths.includes(ctxMenu.file.path) ? selectedPaths.length : 1
              return count > 1 ? `删除 ${count} 项` : '删除'
            })()
          }
        />
      )}
    </div>
  )
}
