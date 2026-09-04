import { useEffect, useRef, useState } from 'react'
import { Plus, X, Server, ChevronLeft, ChevronRight, Loader2, PanelRight, Settings } from 'lucide-react'
import logoSrc from './assets/logo.png'
import { useStore } from './store'
import { TerminalView } from './components/TerminalView'
import { FileManager } from './components/FileManager'
import { CredentialsModal } from './components/CredentialsModal'
import { HostsModal } from './components/HostsModal'
import { AppDialogHost } from './components/AppDialogHost'
import { LoginPromptDialog } from './components/LoginPromptDialog'
import { ToastHost } from './components/ToastHost'

import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { TransferProgress, BookmarkTab } from './types'
import './styles/app.css'

const APP_ZOOM_STORAGE_KEY = 'tinyterm.appZoom'
const APP_ZOOM_STEP = 0.1
const APP_ZOOM_MIN = 0.8
const APP_ZOOM_MAX = 1.4
const ADD_SESSION_MIN_LOADING_MS = 600
const CONNECTION_CHECK_INTERVAL_MS = 15000

function clampAppZoom(value: number) {
  return Math.min(APP_ZOOM_MAX, Math.max(APP_ZOOM_MIN, Number(value.toFixed(2))))
}

export default function App() {
  const {
    loadAll,
    bookmarkTabs,
    activeBookmarkTabId,
    setActiveBookmarkTab,
    removeBookmarkTab,
    updateTransfer,
    credentialsModalOpen,
    hostsModalOpen,
    openHostsModal,
    closeSession,
    setActiveSession,
    openSession,
    toggleSideTerminal,
    markHostSessionsDisconnected,
    reconnectHostSessions,
    hostReachabilityById,
    setHostReachability,
    appZoom,
    setAppZoom,
  } = useStore()

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [addingSessionByTab, setAddingSessionByTab] = useState<Record<string, boolean>>({})
  const [togglingSideTerminal, setTogglingSideTerminal] = useState<Record<string, boolean>>({})
  const [newSessionIds, setNewSessionIds] = useState<Set<string>>(new Set())
  const [hostPingFlashIds, setHostPingFlashIds] = useState<Set<string>>(new Set())
  const hostFailureCountRef = useRef<Record<string, number>>({})
  const hostPingFlashTimeoutRef = useRef<number | null>(null)
  const reconnectingHostIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    void (async () => {
      await loadAll()
    })()
    
    const unlisten = listen<TransferProgress>('transfer-progress', event => {
      updateTransfer(event.payload)
    })
    return () => {
      unlisten.then(fn => fn())
    }
  }, [])

  useEffect(() => {
    // Apply zoom factor as CSS variable for UI scaling
    document.documentElement.style.setProperty('--app-zoom', String(appZoom))
    window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, String(appZoom))
  }, [appZoom])

  useEffect(() => {
    const handleGlobalZoom = (event: KeyboardEvent) => {
      const hasZoomModifier = event.ctrlKey || event.metaKey
      if (!hasZoomModifier || event.altKey) return

      const isZoomIn = event.key === '+' || event.key === '=' || event.key === 'Add' || event.code === 'NumpadAdd'
      const isZoomOut = event.key === '-' || event.key === '_' || event.key === 'Subtract' || event.code === 'NumpadSubtract'
      const isZoomReset = event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0'

      if (!isZoomIn && !isZoomOut && !isZoomReset) return

      event.preventDefault()
      event.stopPropagation()

      const newZoom = isZoomReset ? 0.8 : isZoomIn ? clampAppZoom(appZoom + APP_ZOOM_STEP) : clampAppZoom(appZoom - APP_ZOOM_STEP)
      setAppZoom(newZoom)
    }

    window.addEventListener('keydown', handleGlobalZoom, true)
    return () => window.removeEventListener('keydown', handleGlobalZoom, true)
  }, [appZoom, setAppZoom])

  useEffect(() => {
    let disposed = false

    const runHostPingCheck = async () => {
      const state = useStore.getState()
      const openedHostIds = new Set(
        state.bookmarkTabs
          .map(tab => tab.hostId || tab.bookmarkId)
          .filter((id): id is string => Boolean(id))
      )
      const targets = Array.from(openedHostIds)
        .map(id => state.hosts.find(host => host.id === id))
        .filter((host): host is (typeof state.hosts)[number] => Boolean(host))
        .map(host => ({ id: host.id, host: host.host, port: host.port }))
      const activeHostIds = new Set(targets.map(t => t.id))
      const tickFlashIds: string[] = []

      Object.keys(hostFailureCountRef.current).forEach(id => {
        if (!activeHostIds.has(id)) {
          delete hostFailureCountRef.current[id]
        }
      })

      await Promise.all(targets.map(async target => {
        let reachable = false
        try {
          reachable = await invoke<boolean>('check_host_port', { host: target.host, port: target.port })
        } catch {
          reachable = false
        }

        if (disposed) return

        if (reachable) {
          hostFailureCountRef.current[target.id] = 0
          setHostReachability(target.id, 'reachable')
          tickFlashIds.push(target.id)

          const hasReconnectableSessions = state.bookmarkTabs.some(tab => {
            const tabHostId = tab.hostId || tab.bookmarkId
            if (tabHostId !== target.id) return false
            return tab.sessions.some(session => session.status === 'disconnected' || session.status === 'error')
          })

          if (hasReconnectableSessions && !reconnectingHostIdsRef.current.has(target.id)) {
            reconnectingHostIdsRef.current.add(target.id)
            try {
              await reconnectHostSessions(target.id)
            } finally {
              reconnectingHostIdsRef.current.delete(target.id)
            }
          }
          return
        }

        const nextFailCount = (hostFailureCountRef.current[target.id] ?? 0) + 1
        hostFailureCountRef.current[target.id] = nextFailCount
        const isAlreadyUnreachable = (state.hostReachabilityById[target.id] ?? 'unknown') === 'unreachable'

        if (nextFailCount >= 2) {
          setHostReachability(target.id, 'unreachable')
          if (!isAlreadyUnreachable) {
            await markHostSessionsDisconnected(target.id, 'SSH 端口检测连续失败 2 次，连接已断开。')
          }
        }
      }))

      if (disposed) return
      if (hostPingFlashTimeoutRef.current !== null) {
        window.clearTimeout(hostPingFlashTimeoutRef.current)
      }
      setHostPingFlashIds(new Set(tickFlashIds))
      hostPingFlashTimeoutRef.current = window.setTimeout(() => {
        setHostPingFlashIds(new Set())
        hostPingFlashTimeoutRef.current = null
      }, 420)
    }

    const runChecks = async () => {
      await runHostPingCheck()
    }

    void runChecks()
    const timer = window.setInterval(() => {
      void runChecks()
    }, CONNECTION_CHECK_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(timer)
      if (hostPingFlashTimeoutRef.current !== null) {
        window.clearTimeout(hostPingFlashTimeoutRef.current)
      }
    }
  }, [markHostSessionsDisconnected, reconnectHostSessions, setHostReachability])



  const handleAddSession = async (bookmarkTabId: string) => {
    if (addingSessionByTab[bookmarkTabId]) return

    const tab = bookmarkTabs.find(t => t.id === bookmarkTabId)
    if (!tab) return
    const hostId = tab.hostId || tab.bookmarkId
    if (!hostId) return

    const startedAt = performance.now()
    setAddingSessionByTab(state => ({ ...state, [bookmarkTabId]: true }))

    // Let browser render loading state
    await new Promise(r => requestAnimationFrame(r))
    await new Promise(r => setTimeout(r, 50))

    try {
      await openSession(hostId, bookmarkTabId)
      
      // Mark the new session for animation
      // Get fresh state after openSession completes
      const currentTabs = useStore.getState().bookmarkTabs
      const updatedTab = currentTabs.find(t => t.id === bookmarkTabId)
      const newSessionId = updatedTab?.activeSessionId
      if (newSessionId) {
        setNewSessionIds(prev => new Set(prev).add(newSessionId))
        // Remove after animation completes
        setTimeout(() => {
          setNewSessionIds(prev => {
            const next = new Set(prev)
            next.delete(newSessionId)
            return next
          })
        }, 1600) // Slightly longer than animation duration
      }
    } finally {
      const elapsed = performance.now() - startedAt
      const remaining = Math.max(0, ADD_SESSION_MIN_LOADING_MS - elapsed)
      setTimeout(() => {
        setAddingSessionByTab(state => {
          const next = { ...state }
          delete next[bookmarkTabId]
          return next
        })
      }, remaining)
    }
  }
  const handleToggleSideTerminal = async (bookmarkTabId: string, sessionTabId: string) => {
    const key = `${bookmarkTabId}:${sessionTabId}`
    if (togglingSideTerminal[key]) return

    const tab = bookmarkTabs.find(t => t.id === bookmarkTabId)
    const session = tab?.sessions.find(s => s.id === sessionTabId)
    if (!tab || !session) return

    // 如果已经打开，直接关闭（无需 loading）
    if (session.sideTerminalOpen) {
      await toggleSideTerminal(bookmarkTabId, sessionTabId)
      return
    }

    // 打开时显示 loading
    setTogglingSideTerminal(state => ({ ...state, [key]: true }))

    // 让浏览器有机会渲染 loading 状态
    await new Promise(resolve => requestAnimationFrame(resolve))
    await new Promise(resolve => requestAnimationFrame(resolve))

    try {
      await toggleSideTerminal(bookmarkTabId, sessionTabId)
    } finally {
      setTogglingSideTerminal(state => {
        const next = { ...state }
        delete next[key]
        return next
      })
    }
  }
  return (
    <div className="app-root">
      <div className="app-container">
        {/* ── Body: sidebar + content ───────────────────── */}
        <div className="app-body">

          {/* ── Left sidebar: Host tabs ───────────────── */}
          <div className={`host-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            <div className="host-sidebar-inner">
              {bookmarkTabs.length === 0 ? (
                <div className="host-sidebar-empty">
                  <Server size={20} strokeWidth={1.5} opacity={0.35} />
                  {!sidebarCollapsed && <span>无主机</span>}
                </div>
              ) : (
                <div className="host-sidebar-tabs">
                  {bookmarkTabs.map((tab, index) => {
                    const sessionStatus = tab.sessions.find(
                      s => s.id === tab.activeSessionId
                    )?.status ?? 'idle'
                    const hostId = tab.hostId || tab.bookmarkId
                    const hostReachability = hostId ? (hostReachabilityById[hostId] ?? 'unknown') : 'unknown'
                    const isHostUnreachable = hostReachability === 'unreachable'
                    const isPingTickFlash = hostId ? hostPingFlashIds.has(hostId) : false
                    const hostColor =
                      hostId
                        ? (useStore.getState().hosts.find(h => h.id === hostId)?.color ?? '#7c5cbf')
                        : '#7c5cbf'
                    return (
                      <div
                        key={tab.id}
                        className={`host-sidebar-tab ${tab.id === activeBookmarkTabId ? 'active' : ''} ${isHostUnreachable ? 'host-unreachable' : ''}`}
                        onClick={() => setActiveBookmarkTab(tab.id)}
                        title={tab.title}
                        style={{
                          ['--host-accent' as any]: hostColor,
                        }}
                      >
                        <span className={`host-dot status-${sessionStatus} ${isHostUnreachable ? 'ping-unreachable' : ''} ${isPingTickFlash ? 'ping-check-flash' : ''}`}>{index + 1}</span>
                        {!sidebarCollapsed && (
                          <span className="host-sidebar-tab-title">{tab.title}</span>
                        )}
                        {!sidebarCollapsed && (
                          <button
                            className="host-sidebar-tab-close"
                            onClick={e => {
                              e.stopPropagation()
                              removeBookmarkTab(tab.id)
                            }}
                            title="关闭"
                          >
                            <X size={11} strokeWidth={2.5} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {sidebarCollapsed ? (
                <button
                  className="host-sidebar-add-icon"
                  onClick={openHostsModal}
                  title="主机管理"
                >
                  <Settings size={14} strokeWidth={2.5} />
                </button>
              ) : (
                <button
                  className="host-sidebar-add"
                  onClick={openHostsModal}
                  title="主机管理"
                >
                  <Settings size={13} strokeWidth={2.5} />
                  <span>主机管理</span>
                </button>
              )}
            </div>

            <button
              className="sidebar-collapse-btn"
              onClick={() => setSidebarCollapsed(c => !c)}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            >
              {sidebarCollapsed
                ? <ChevronRight size={13} strokeWidth={2} />
                : <ChevronLeft size={13} strokeWidth={2} />
              }
            </button>
          </div>

          {/* ── Main content area ─────────────────────── */}
          <div className="main-content">
            {bookmarkTabs.length === 0 ? (
              /* Empty state — no host tabs at all */
              <div className="empty-state glass-panel">
                <div className="empty-state-content">
                  <div className="empty-icon">
                    <img src={logoSrc} alt="TinyTerm logo" />
                  </div>
                  <h2>TinyTerm</h2>
                  <p>
                    点击左侧 <strong>主机管理</strong> 添加主机并开始连接
                  </p>
                </div>
              </div>
            ) : (
              /*
               * Render ALL bookmark tabs simultaneously.
               * Only the active one is visible; others have display:none.
               * This preserves xterm instances across tab switches.
               */
              bookmarkTabs.map(bookmarkTab => (
                <HostTabPanel
                  key={bookmarkTab.id}
                  bookmarkTab={bookmarkTab}
                  isActive={bookmarkTab.id === activeBookmarkTabId}
                  onAddSession={handleAddSession}
                  addingSession={Boolean(addingSessionByTab[bookmarkTab.id])}
                  onCloseSession={closeSession}
                  onSetActiveSession={setActiveSession}
                  onToggleSideTerminal={handleToggleSideTerminal}
                  togglingSideTerminal={togglingSideTerminal}
                  newSessionIds={newSessionIds}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {credentialsModalOpen && <CredentialsModal />}
      {hostsModalOpen && <HostsModal />}
      <AppDialogHost />
      <LoginPromptDialog />
      <ToastHost />
    </div>
  )
}

// ── Per-host panel (session tabs + terminals) ─────────────────────────────────
// Rendered for every BookmarkTab, hidden via CSS when not active.
// This is the key to preserving xterm instances across host-tab switches.

interface HostTabPanelProps {
  bookmarkTab: BookmarkTab
  isActive: boolean
  onAddSession: (bookmarkTabId: string) => Promise<void>
  addingSession: boolean
  onCloseSession: (bookmarkTabId: string, sessionTabId: string) => void
  onSetActiveSession: (bookmarkTabId: string, sessionTabId: string) => void
  onToggleSideTerminal: (bookmarkTabId: string, sessionTabId: string) => void
  togglingSideTerminal: Record<string, boolean>
  newSessionIds: Set<string>
}

function HostTabPanel({
  bookmarkTab,
  isActive,
  onAddSession,
  addingSession,
  onCloseSession,
  onSetActiveSession,
  onToggleSideTerminal,
  togglingSideTerminal,
  newSessionIds,
}: HostTabPanelProps) {
  const handleAddSession = () => {
    if (addingSession) return
    void onAddSession(bookmarkTab.id)
  }

  // 获取当前活动 session
  const activeSession = bookmarkTab.sessions.find(s => s.id === bookmarkTab.activeSessionId)
  const hasSideTerminal = activeSession?.sideTerminalOpen || false
  const sideTerminalKey = activeSession ? `${bookmarkTab.id}:${activeSession.id}` : ''
  const isTogglingSideTerminal = togglingSideTerminal[sideTerminalKey] || false

  return (
    <div
      className="content-area"
      style={{ display: isActive ? 'flex' : 'none' }}
    >
      {/* ── Session tab strip ── */}
      <div className="session-tabstrip">
        <div className="session-tabs-scroll">
          {bookmarkTab.sessions.map((session, index) => (
            <div
              key={session.id}
              className={`session-chrome-tab ${session.id === bookmarkTab.activeSessionId ? 'active' : ''} status-${session.status} ${newSessionIds.has(session.id) ? 'new-tab' : ''}`}
              onClick={() => onSetActiveSession(bookmarkTab.id, session.id)}
            >
              <span className="session-chrome-dot" />
              <span className="session-chrome-title">
                {session.title || `终端 ${index + 1}`}
              </span>
              <button
                className="session-chrome-close"
                onClick={e => {
                  e.stopPropagation()
                  onCloseSession(bookmarkTab.id, session.id)
                }}
                title="关闭标签"
              >
                <X size={11} strokeWidth={2.5} />
              </button>
            </div>
          ))}

          {/* 加号按钮移到 tabs 内部最后 */}
          {(bookmarkTab.hostId || bookmarkTab.bookmarkId) && (
            <button
              className={`session-tab-new-inline ${addingSession ? 'is-loading' : ''}`}
              onClick={handleAddSession}
              disabled={addingSession}
              title={addingSession ? '正在新建终端...' : '新建终端'}
            >
              {addingSession
                ? <Loader2 size={14} strokeWidth={2.5} />
                : <Plus size={14} strokeWidth={2.5} />}
            </button>
          )}
        </div>

        {/* 辅助终端按钮 */}
        {bookmarkTab.sessions.length > 0 && activeSession && (
          <button
            className={`session-side-terminal-btn ${isTogglingSideTerminal ? 'is-loading' : ''} ${hasSideTerminal ? 'is-active' : ''}`}
            onClick={() => onToggleSideTerminal(bookmarkTab.id, activeSession.id)}
            disabled={isTogglingSideTerminal}
            title={
              isTogglingSideTerminal
                ? '正在打开辅助终端...'
                : hasSideTerminal
                ? '关闭辅助终端'
                : '打开右侧辅助终端'
            }
          >
            {isTogglingSideTerminal
              ? <Loader2 size={14} strokeWidth={2.5} />
              : <PanelRight size={14} strokeWidth={2.5} />}
          </button>
        )}
      </div>



      {/* ── Terminal workspace ── */}
      <div className="workspace">
        {bookmarkTab.sessions.length === 0 ? (
          <div className="terminal-area glass-panel">
            <div className="terminal-inner">
              <div className="empty-session">
                <div className="empty-session-icon">
                  <img
                    src={logoSrc}
                    alt="TinyTerm logo"
                    style={{
                      width: '62%',
                      height: '62%',
                      objectFit: 'contain',
                      opacity: 0.92,
                      filter: 'drop-shadow(0 0 10px rgba(80, 150, 255, 0.18))',
                    }}
                  />
                </div>
                <p>点击 + 新建终端连接</p>
              </div>
            </div>
          </div>
        ) : (
          /*
           * Render ALL sessions for this host simultaneously.
           * Only the active session's terminal-area is visible.
           * This preserves xterm instances across session-tab switches.
           */
          bookmarkTab.sessions.map(session => (
            <div
              key={session.id}
              className={`terminal-area glass-panel ${session.id === bookmarkTab.activeSessionId ? '' : 'hidden'}`}
            >
              <div
                className="terminal-inner"
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: session.sideTerminalOpen ? '6px' : '0',
                }}
              >
                <div style={{ flex: session.sideTerminalOpen ? '1 1 50%' : '1 1 100%', minWidth: 0, minHeight: 0 }}>
                  <TerminalView
                    session={session}
                    isVisible={session.id === bookmarkTab.activeSessionId && isActive}
                  />
                </div>

                {session.sideTerminalOpen && session.sideTerminalSessionId && session.sideTerminalStatus === 'connected' && (
                  <div
                    style={{
                      flex: '1 1 50%',
                      minWidth: 0,
                      minHeight: 0,
                      borderLeft: '1px solid rgba(100, 160, 255, 0.18)',
                      position: 'relative',
                    }}
                  >
                    <TerminalView
                      session={session}
                      backendSessionId={session.sideTerminalSessionId}
                      isVisible={session.id === bookmarkTab.activeSessionId && isActive}
                    />
                  </div>
                )}

                {session.sideTerminalOpen && session.sideTerminalStatus === 'connecting' && (
                  <div
                    style={{
                      flex: '1 1 50%',
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'rgba(200, 210, 255, 0.72)',
                      fontSize: '12px',
                      borderLeft: '1px solid rgba(100, 160, 255, 0.18)',
                    }}
                  >
                    正在打开辅助终端...
                  </div>
                )}

                {session.sideTerminalOpen && session.sideTerminalStatus === 'error' && (
                  <div
                    style={{
                      flex: '1 1 50%',
                      minWidth: 0,
                      minHeight: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#ff8f8f',
                      fontSize: '12px',
                      borderLeft: '1px solid rgba(100, 160, 255, 0.18)',
                      padding: '12px',
                      textAlign: 'center',
                    }}
                  >
                    {session.sideTerminalError || '辅助终端打开失败'}
                  </div>
                )}
              </div>

              {session.status === 'connected' && (
                <FileManager
                  session={session}
                  bookmarkTabId={bookmarkTab.id}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}