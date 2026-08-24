import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { invoke, Channel } from '@tauri-apps/api/core'
import type { SessionTab } from '../types'
import { useStore } from '../store'
import { LoadingBlocks } from './LoadingBlocks'
import { TerminalQuickActions } from './TerminalQuickActions'
import { Copy, ClipboardPaste } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import './TerminalView.css'

const TERMINAL_THEME = {
  background: '#08111b',
  foreground: '#aebdca',
  cursor: '#ffbf69',
  cursorAccent: '#08111b',
  selectionBackground: 'rgba(115, 167, 255, 0.24)',
  black: '#16202b',
  red: '#ef6b73',
  green: '#7ccf92',
  yellow: '#e7c36f',
  blue: '#73a7ff',
  magenta: '#c792ea',
  cyan: '#66c7d1',
  white: '#b7c4cf',
  brightBlack: '#55606d',
  brightRed: '#ff8b94',
  brightGreen: '#99e6a8',
  brightYellow: '#ffd98a',
  brightBlue: '#94c2ff',
  brightMagenta: '#ddb3ff',
  brightCyan: '#8be0e8',
  brightWhite: '#d7e1ea',
}

function encodeKeyEvent(event: KeyboardEvent, appCursorKeys: boolean): string | null {
  if (event.metaKey) return null

  if (event.ctrlKey && !event.altKey) {
    const key = event.key
    if (key.length === 1) {
      const ch = key.toUpperCase()
      const code = ch.charCodeAt(0)
      if (code >= 65 && code <= 90) {
        return String.fromCharCode(code - 64)
      }
      if (key === ' ') return '\x00'
      if (key === '[') return '\x1b'
      if (key === '\\') return '\x1c'
      if (key === ']') return '\x1d'
      if (key === '^') return '\x1e'
      if (key === '_') return '\x1f'
    }
  }

  // In application cursor mode (DECCKM), set by vim etc., arrow keys
  // and Home/End use SS3 (\x1bO) instead of CSI (\x1b[).
  const escPrefix = appCursorKeys ? '\x1bO' : '\x1b['

  switch (event.key) {
    case 'Enter':
      return '\r'
    case 'Tab':
      return event.shiftKey ? '\x1b[Z' : '\t'
    case 'Backspace':
      return '\x7f'
    case 'Escape':
      return '\x1b'
    case 'ArrowUp':
      return escPrefix + 'A'
    case 'ArrowDown':
      return escPrefix + 'B'
    case 'ArrowRight':
      return escPrefix + 'C'
    case 'ArrowLeft':
      return escPrefix + 'D'
    case 'Home':
      return escPrefix + 'H'
    case 'End':
      return escPrefix + 'F'
    case 'Delete':
      return '\x1b[3~'
    case 'Insert':
      return '\x1b[2~'
    case 'PageUp':
      return '\x1b[5~'
    case 'PageDown':
      return '\x1b[6~'
    default:
      break
  }

  if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
    return event.key
  }

  if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
    return '\x1b' + event.key
  }

  return null
}

interface Props {
  session: SessionTab
  isVisible: boolean
  backendSessionId?: string
}

export function TerminalView({ session, isVisible, backendSessionId }: Props) {
  const termRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(isVisible)
  const sessionIdRef = useRef<string | null>(null)

  const settings = useStore(s => s.settings)
  const reconnectHostSessions = useStore(s => s.reconnectHostSessions)
  const appZoom = useStore(s => s.appZoom)
  const addToast = useStore(s => s.addToast)

  const [passwordInput, setPasswordInput] = useState('')
  const [reconnecting, setReconnecting] = useState(false)
  const [showLoading, setShowLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [pasteConfirm, setPasteConfirm] = useState<string | null>(null)

  const isAuthError =
    session.status === 'error' &&
    /auth|password|credential|permission denied/i.test(session.error ?? '')

  useEffect(() => {
    visibleRef.current = isVisible
  }, [isVisible])

  // ── Terminal setup ────────────────────────────────────────────────────────

  useEffect(() => {
    const resolvedSessionId = backendSessionId ?? session.sessionId
    if (!termRef.current || !resolvedSessionId || session.status !== 'connected') return

    const sessionId = resolvedSessionId
    sessionIdRef.current = sessionId

    const baseFontSize = settings?.font_size ?? 12
    const zoomFactor = typeof appZoom === 'number' && appZoom > 0 ? appZoom : 1
    const initialFontSize = Math.max(8, Math.round(baseFontSize * zoomFactor))

    const term = new Terminal({
      cursorBlink: settings?.cursor_blink ?? true,
      cursorStyle: (settings?.cursor_style as any) ?? 'block',
      fontSize: initialFontSize,
      fontFamily: settings?.font_family ?? "Menlo, Monaco, 'Courier New', monospace",
      theme: TERMINAL_THEME,
      scrollback: settings?.scrollback ?? 5000,
      allowTransparency: false,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(termRef.current)

    if (visibleRef.current && termRef.current.clientWidth > 0 && termRef.current.clientHeight > 0) {
      fitAddon.fit()
    }

    // Focus the terminal textarea so a freshly opened window is immediately
    // ready for keyboard input without requiring a mouse click.
    if (visibleRef.current) {
      term.focus()
    }

    xtermRef.current = term
    fitAddonRef.current = fitAddon

    // ── Input: custom keyboard path ───────────────────────────────────────
    //
    // In some macOS WebView environments xterm's textarea/input pipeline can
    // miss fast consecutive printable characters. We keep xterm for rendering,
    // selection and output, but send keyboard input through a native keydown
    // handler so each physical key event maps directly to terminal bytes.

    const sendToSession = (data: string) => {
      invoke('write_to_session', { sessionId, data }).catch(() => {})
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return

      // Let Ctrl/Cmd+V pass through so the native paste event fires
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modifier = isMac ? event.metaKey : event.ctrlKey
      if (modifier && event.key === 'v') return

      const data = encodeKeyEvent(event, term.modes.applicationCursorKeysMode)
      if (!data) return

      event.preventDefault()
      event.stopPropagation()
      sendToSession(data)
    }

    const textarea = term.textarea
    textarea?.addEventListener('keydown', handleKeyDown, true)

    term.onBinary(data => {
      sendToSession(data)
    })

    // ── Copy shortcut (scoped to terminal container) ──────────────────────
    // Paste is NOT intercepted here — we let the native paste event reach
    // the textarea, where `handlePasteEvent` captures it and shows our
    // confirmation dialog. This avoids the browser's native "paste" prompt.

    const handleTerminalKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modifier = isMac ? event.metaKey : event.ctrlKey

      if (modifier && event.key === 'c' && term.hasSelection()) {
        event.preventDefault()
        event.stopPropagation()
        const selection = term.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
            .then(() => addToast({ message: '复制成功', type: 'success' }))
            .catch(() => addToast({ message: '复制失败', type: 'error' }))
        }
        return
      }
      // Ctrl/Cmd+V is intentionally NOT handled here so the native paste
      // event fires on the textarea and is caught by handlePasteEvent.
    }

    termRef.current?.addEventListener('keydown', handleTerminalKeyDown, true)

    // ── Handle copy/paste events from context menu ────────────────────────

    const handleCopyEvent = (event: ClipboardEvent) => {
      const selection = term.getSelection()
      if (selection) {
        event.preventDefault()
        event.clipboardData?.setData('text/plain', selection)
        addToast({ message: '复制成功', type: 'success' })
      }
    }

    const handlePasteEvent = (event: ClipboardEvent) => {
      event.preventDefault()
      const text = event.clipboardData?.getData('text')
      if (text) {
        setPasteConfirm(text)
      }
    }

    // Listen on textarea directly for copy/paste from context menu
    textarea?.addEventListener('copy', handleCopyEvent)
    textarea?.addEventListener('paste', handlePasteEvent)

    // ── Resize ────────────────────────────────────────────────────────────

    term.onResize(({ cols, rows }) => {
      invoke('resize_terminal', { sessionId, cols, rows }).catch(() => {})
    })

    // ── Output: direct write, no batching ─────────────────────────────────
    //
    // Like the reference project:
    //   socket.onmessage = (ev) => term.write(ev.data)
    //
    // The Rust reader thread already batches output in 5ms windows before
    // sending via Channel, so we don't need to batch again on the JS side.

    const channel = new Channel<string>()
    channel.onmessage = (data: string) => {
      term.write(data)
    }

    invoke('subscribe_session', { sessionId, dataChannel: channel }).catch(
      err => console.error('subscribe_session:', err),
    )

    // ── Auto clear MOTD + hide loading ────────────────────────────────────

    const clearTimeoutId = setTimeout(() => {
      invoke('write_to_session', { sessionId, data: 'clear\r' }).catch(() => {})
    }, 400)

    const loadingTimeoutId = setTimeout(() => {
      setShowLoading(false)
    }, 800)

    // ── Right-click context menu ──────────────────────────────────────────

    const container = termRef.current

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      setContextMenu({ x: event.clientX, y: event.clientY })
    }

    container?.addEventListener('contextmenu', handleContextMenu)

    // ── ResizeObserver ────────────────────────────────────────────────────

    const ro = new ResizeObserver(() => {
      if (!visibleRef.current || !termRef.current) return
      if (termRef.current.clientWidth === 0 || termRef.current.clientHeight === 0) return
      fitAddon.fit()
    })
    ro.observe(termRef.current!)

    // ── Cleanup ───────────────────────────────────────────────────────────

    return () => {
      clearTimeout(clearTimeoutId)
      clearTimeout(loadingTimeoutId)
      ro.disconnect()
      container?.removeEventListener('contextmenu', handleContextMenu)
      container?.removeEventListener('keydown', handleTerminalKeyDown, true)
      textarea?.removeEventListener('copy', handleCopyEvent)
      textarea?.removeEventListener('paste', handlePasteEvent)
      textarea?.removeEventListener('keydown', handleKeyDown, true)
      term.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
      sessionIdRef.current = null
    }
  }, [
    backendSessionId,
    session.sessionId,
    session.status,
    settings?.cursor_blink,
    settings?.cursor_style,
    settings?.font_family,
    settings?.font_size,
    settings?.scrollback,
  ])

  // ── Dynamic font size update on zoom change ──────────────────────────────

  useEffect(() => {
    const term = xtermRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return

    const baseFontSize = settings?.font_size ?? 12
    const zoomFactor = typeof appZoom === 'number' && appZoom > 0 ? appZoom : 1
    const scaledFontSize = Math.max(8, Math.round(baseFontSize * zoomFactor))

    if (term.options.fontSize !== scaledFontSize) {
      term.options.fontSize = scaledFontSize
      // Give the terminal a moment to apply the new font size
      setTimeout(() => {
        if (termRef.current && termRef.current.clientWidth > 0 && termRef.current.clientHeight > 0) {
          fitAddon.fit()
        }
      }, 10)
    }
  }, [appZoom, settings?.font_size])

  // Re-fit when the tab becomes visible
  useEffect(() => {
    if (!isVisible) return

    const resolvedSessionId = backendSessionId ?? session.sessionId
    const t = setTimeout(() => {
      const container = termRef.current
      const fitAddon = fitAddonRef.current
      const term = xtermRef.current
      if (!container || !fitAddon || !term) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return

      fitAddon.fit()

      // Refocus when the tab becomes visible so typing is immediately ready
      // after switching to an existing session.
      term.focus()

      if (resolvedSessionId) {
        invoke('resize_terminal', {
          sessionId: resolvedSessionId,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {})
      }
    }, 30)

    return () => clearTimeout(t)
  }, [isVisible, backendSessionId, session.sessionId])

  // ── Reconnect handling ────────────────────────────────────────────────────

  const handleReconnect = async () => {
    setReconnecting(true)
    try {
      await reconnectHostSessions(session.bookmarkId, isAuthError ? passwordInput : undefined)
    } finally {
      setReconnecting(false)
      setPasswordInput('')
    }
  }

  const handleQuickWrite = (data: string) => {
    const resolvedSessionId = backendSessionId ?? session.sessionId
    if (!resolvedSessionId) return
    invoke('write_to_session', { sessionId: resolvedSessionId, data }).catch(() => {})
  }

  // ── Context menu actions ─────────────────────────────────────────────────

  const handleMenuCopy = () => {
    const term = xtermRef.current
    if (!term) return
    const selection = term.getSelection()
    if (selection) {
      navigator.clipboard.writeText(selection)
        .then(() => addToast({ message: '复制成功', type: 'success' }))
        .catch(() => addToast({ message: '复制失败', type: 'error' }))
    }
    setContextMenu(null)
  }

  const handleMenuPaste = () => {
    setContextMenu(null)
    if (session.status !== 'connected') return
    // Trigger native paste via the textarea so handlePasteEvent catches it
    // without triggering the browser's clipboard permission prompt.
    const term = xtermRef.current
    if (term?.textarea) {
      term.textarea.focus()
      document.execCommand('paste')
    }
  }

  const handlePasteConfirm = () => {
    if (!pasteConfirm) return
    const resolvedSessionId = backendSessionId ?? session.sessionId
    if (resolvedSessionId) {
      invoke('write_to_session', { sessionId: resolvedSessionId, data: pasteConfirm }).catch(() => {})
      addToast({ message: '粘贴成功', type: 'success' })
    }
    setPasteConfirm(null)
  }

  const handlePasteCancel = () => {
    setPasteConfirm(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="terminal-wrapper">
      {session.status === 'connected' && (
        <TerminalQuickActions
          sessionId={backendSessionId ?? session.sessionId ?? ''}
          onWrite={handleQuickWrite}
          fmOpen={session.fmOpen}
        />
      )}
      {(session.status === 'error' || session.status === 'disconnected') && (
        <div className={`terminal-status ${session.status === 'disconnected' ? 'disconnected' : 'error'}`}>
          <div className="error-header">
            <span className="error-icon">⚠</span>
            <span>{session.status === 'disconnected' ? '连接已断开' : '连接失败'}</span>
          </div>
          <div className="error-detail">{session.error}</div>

          {isAuthError && session.status === 'error' && (
            <div className="reconnect-form">
              <input
                type="password"
                className="reconnect-password"
                placeholder="输入密码重试..."
                value={passwordInput}
                onChange={e => setPasswordInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleReconnect() }}
                autoFocus
              />
            </div>
          )}

          <button
            className="reconnect-btn"
            disabled={reconnecting}
            onClick={handleReconnect}
          >
            {reconnecting ? '重新连接中...' : '↺ 重新连接'}
          </button>
        </div>
      )}

      <div ref={termRef} className="terminal-container" />
      {showLoading && session.status === 'connected' && (
        <div className="terminal-loading-overlay">
          <LoadingBlocks />
        </div>
      )}

      {contextMenu && createPortal(
        <>
          <div
            className="terminal-contextmenu-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={e => {
              e.preventDefault()
              const termEl = termRef.current
              if (termEl) {
                const rect = termEl.getBoundingClientRect()
                const inside =
                  e.clientX >= rect.left &&
                  e.clientX <= rect.right &&
                  e.clientY >= rect.top &&
                  e.clientY <= rect.bottom
                if (inside) {
                  setContextMenu({ x: e.clientX, y: e.clientY })
                  return
                }
              }
              setContextMenu(null)
            }}
          />
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onCopy={handleMenuCopy}
            onPaste={handleMenuPaste}
            canCopy={!!xtermRef.current?.getSelection()}
          />
        </>,
        document.body,
      )}

      {pasteConfirm !== null && createPortal(
        <PasteConfirmDialog
          text={pasteConfirm}
          onConfirm={handlePasteConfirm}
          onCancel={handlePasteCancel}
        />,
        document.body,
      )}
    </div>
  )
}

// ── Context Menu sub-component with viewport boundary check ───────────────

interface ContextMenuProps {
  x: number
  y: number
  onCopy: () => void
  onPaste: () => void
  canCopy: boolean
}

function ContextMenu({ x, y, onCopy, onPaste, canCopy }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    let nextX = x
    let nextY = y

    // Prevent overflow on right edge
    if (x + rect.width > vw) {
      nextX = Math.max(4, vw - rect.width - 4)
    }
    // Prevent overflow on bottom edge
    if (y + rect.height > vh) {
      nextY = Math.max(4, vh - rect.height - 4)
    }

    setPosition({ x: nextX, y: nextY })
  }, [x, y])

  return (
    <div
      ref={menuRef}
      className="terminal-contextmenu"
      style={{ left: position.x, top: position.y }}
    >
      <button className="terminal-contextmenu-item" disabled={!canCopy} onClick={onCopy}>
        <Copy size={13} />
        <span>复制</span>
      </button>
      <button className="terminal-contextmenu-item" onClick={onPaste}>
        <ClipboardPaste size={13} />
        <span>粘贴</span>
      </button>
    </div>
  )
}

// ── Paste Confirm Dialog ──────────────────────────────────────────────────

interface PasteConfirmDialogProps {
  text: string
  onConfirm: () => void
  onCancel: () => void
}

function PasteConfirmDialog({ text, onConfirm, onCancel }: PasteConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onConfirm, onCancel])

  useEffect(() => {
    confirmBtnRef.current?.focus()
  }, [])

  const lineCount = text.split('\n').length
  const charCount = text.length
  const preview = text.length > 2000 ? text.slice(0, 2000) + '\n...' : text

  return (
    <div className="paste-confirm-overlay" onClick={onCancel}>
      <div className="paste-confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className="paste-confirm-header">
          <ClipboardPaste size={16} />
          <span>粘贴确认</span>
          <span className="paste-confirm-meta">{lineCount} 行 · {charCount} 字符</span>
        </div>
        <div className="paste-confirm-preview">
          <pre>{preview}</pre>
        </div>
        <div className="paste-confirm-actions">
          <button className="paste-confirm-btn cancel" onClick={onCancel}>
            取消
          </button>
          <button
            ref={confirmBtnRef}
            className="paste-confirm-btn confirm"
            onClick={onConfirm}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}