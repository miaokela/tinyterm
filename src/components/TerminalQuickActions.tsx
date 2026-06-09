import { useState, useEffect, useCallback, useRef } from 'react'
import { Cpu, HardDrive, Database, BookText, Clock, Play, X, Loader2, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { SystemInfoModal, type QueryType } from './SystemInfoModal'
import './TerminalQuickActions.css'

interface Props {
  sessionId: string
  onWrite: (data: string) => void
  fmOpen?: boolean
}

interface CommandItem {
  label: string
  command: string
}

interface CommandCategory {
  title: string
  items: CommandItem[]
}

const COMMAND_CATEGORIES: CommandCategory[] = [
  {
    title: '服务管理',
    items: [
      { label: '查看服务状态', command: 'systemctl status ' },
      { label: '启动服务', command: 'systemctl start ' },
      { label: '停止服务', command: 'systemctl stop ' },
      { label: '重启服务', command: 'systemctl restart ' },
      { label: '重载服务', command: 'systemctl reload ' },
      { label: '启用开机自启', command: 'systemctl enable ' },
      { label: '禁用开机自启', command: 'systemctl disable ' },
      { label: '查看运行中服务', command: 'systemctl list-units --type=service --state=running' },
      { label: '查看失败服务', command: 'systemctl list-units --failed' },
      { label: '查看服务日志', command: 'journalctl -u ' },
      { label: '实时跟踪日志', command: 'journalctl -u  -f' },
      { label: '查看最近日志', command: 'journalctl -n 50' },
    ],
  },
  {
    title: '进程管理',
    items: [
      { label: '按名称查进程', command: 'ps -ef | grep ' },
      { label: '按名称精确查进程', command: 'pgrep -a ' },
      { label: '按名称杀进程', command: 'pkill -9 ' },
      { label: '按PID杀进程', command: 'kill -9 ' },
      { label: '查看进程树', command: 'pstree -p ' },
      { label: '查看进程详情', command: 'ps aux | grep ' },
      { label: '查看端口占用进程', command: 'lsof -i :' },
      { label: '查看文件占用进程', command: 'lsof ' },
      { label: '查看进程打开的文件', command: 'lsof -p ' },
      { label: '优雅终止进程', command: 'kill -15 ' },
    ],
  },
  {
    title: '网络诊断',
    items: [
      { label: '查看监听端口', command: 'netstat -tlnp' },
      { label: '查看套接字状态', command: 'ss -tlnp' },
      { label: '测试连通性', command: 'ping -c 4 ' },
      { label: '路由追踪', command: 'traceroute ' },
      { label: '查看外网IP', command: 'curl -s ip.sb' },
      { label: 'HTTP请求头', command: 'curl -I -L --max-time 10 ' },
      { label: 'DNS查询', command: 'dig +short ' },
      { label: '查看路由表', command: 'ip route' },
      { label: '查看网络接口', command: 'ip addr' },
      { label: '抓包过滤', command: 'tcpdump -i any -nn host ' },
    ],
  },
  {
    title: '文件与磁盘',
    items: [
      { label: '查看目录大小', command: 'du -sh ' },
      { label: '查找大文件', command: 'du -ah . | sort -rh | head -n 20' },
      { label: '查找空目录', command: 'find . -type d -empty' },
      { label: '按名称查找文件', command: 'find . -name ' },
      { label: '查找最近修改文件', command: 'find . -type f -mtime -1' },
      { label: '压缩目录', command: 'tar -czvf archive.tar.gz ' },
      { label: '解压tar.gz', command: 'tar -xzvf ' },
      { label: '查看文件编码', command: 'file ' },
      { label: '清空日志文件', command: '> ' },
      { label: '查看文件前N行', command: 'head -n 50 ' },
      { label: '查看文件后N行', command: 'tail -n 50 -f ' },
      { label: '统计代码行数', command: 'wc -l ' },
    ],
  },
  {
    title: '系统与权限',
    items: [
      { label: '查看系统负载', command: 'uptime' },
      { label: '查看系统信息', command: 'uname -a' },
      { label: '查看当前用户', command: 'whoami' },
      { label: '查看用户信息', command: 'id' },
      { label: '查看登录用户', command: 'who' },
      { label: '添加执行权限', command: 'chmod +x ' },
      { label: '递归改权限', command: 'chmod -R 755 ' },
      { label: '递归改属主', command: 'chown -R $(whoami):$(whoami) ' },
      { label: '查看环境变量', command: 'env | grep ' },
      { label: '查看定时任务', command: 'crontab -l' },
      { label: '查看已安装包', command: 'rpm -qa | grep ' },
    ],
  },
]

type ActivePopup = null | 'commands' | 'history'

export function TerminalQuickActions({ sessionId, onWrite, fmOpen }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [activePopup, setActivePopup] = useState<ActivePopup>(null)
  const [sysInfoType, setSysInfoType] = useState<QueryType | null>(null)

  const togglePopup = (popup: ActivePopup) => {
    setActivePopup(prev => (prev === popup ? null : popup))
  }

  const handleToggleExpand = () => {
    setExpanded(prev => {
      if (prev) setActivePopup(null) // close any popup when collapsing
      return !prev
    })
  }

  return (
    <>
      <div className={`qa-bar${expanded ? ' expanded' : ''}`}>
        {/* Collapsed state: single toggle button */}
        {!expanded && (
          <button
            className="qa-icon-btn qa-toggle-btn"
            onClick={handleToggleExpand}
            title="展开工具栏"
          >
            <ChevronsLeft size={12} strokeWidth={2.5} />
          </button>
        )}
        {/* Expanded state: all buttons slide in from the right */}
        {expanded && (
          <>
            <button
              className="qa-icon-btn qa-slide-in"
              style={{ animationDelay: '0ms' }}
              onClick={() => setSysInfoType('cpu')}
              title="CPU"
            >
              <Cpu size={10} strokeWidth={2} />
            </button>
            <button
              className="qa-icon-btn qa-slide-in"
              style={{ animationDelay: '50ms' }}
              onClick={() => setSysInfoType('memory')}
              title="内存"
            >
              <Database size={10} strokeWidth={2} />
            </button>
            <button
              className="qa-icon-btn qa-slide-in"
              style={{ animationDelay: '100ms' }}
              onClick={() => setSysInfoType('disk')}
              title="磁盘"
            >
              <HardDrive size={10} strokeWidth={2} />
            </button>
            <button
              className={`qa-icon-btn qa-slide-in${activePopup === 'commands' ? ' active' : ''}`}
              style={{ animationDelay: '150ms' }}
              onClick={() => togglePopup('commands')}
              title="常用指令"
            >
              <BookText size={10} strokeWidth={2} />
            </button>
            <button
              className={`qa-icon-btn qa-slide-in${activePopup === 'history' ? ' active' : ''}`}
              style={{ animationDelay: '200ms' }}
              onClick={() => togglePopup('history')}
              title="历史命令"
            >
              <Clock size={10} strokeWidth={2} />
            </button>
            <button
              className="qa-icon-btn qa-slide-in qa-collapse-btn"
              style={{ animationDelay: '250ms' }}
              onClick={handleToggleExpand}
              title="收起工具栏"
            >
              <ChevronsRight size={10} strokeWidth={2.5} />
            </button>
          </>
        )}
      </div>

      {activePopup === 'commands' && (
        <CommandsPopup
          fmOpen={fmOpen}
          onInput={(cmd) => {
            onWrite(cmd)
            setActivePopup(null)
          }}
          onClose={() => setActivePopup(null)}
        />
      )}

      {activePopup === 'history' && (
        <HistoryPopup
          sessionId={sessionId}
          fmOpen={fmOpen}
          onExecute={(cmd) => {
            onWrite(cmd + '\r')
            setActivePopup(null)
          }}
          onInput={(cmd) => {
            onWrite(cmd)
            setActivePopup(null)
          }}
          onClose={() => setActivePopup(null)}
        />
      )}

      {sysInfoType && (
        <SystemInfoModal
          sessionId={sessionId}
          type={sysInfoType}
          onClose={() => setSysInfoType(null)}
        />
      )}
    </>
  )
}

/* ── Commands Popup ─────────────────────────────────────────────────────── */

function CommandsPopup({
  fmOpen,
  onInput,
  onClose,
}: {
  fmOpen?: boolean
  onInput: (cmd: string) => void
  onClose: () => void
}) {
  return (
    <div className={`qa-popup${fmOpen ? ' fm-open' : ''}`}>
      <div className="qa-popup-header">
        <span className="qa-popup-title">常用指令（双击输入）</span>
        <button className="qa-popup-close" onClick={onClose} title="关闭">
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
      <div className="qa-popup-scroll">
        {COMMAND_CATEGORIES.map(cat => (
          <div key={cat.title} className="qa-cat">
            <div className="qa-cat-title">{cat.title}</div>
            <div className="qa-cat-items">
              {cat.items.map(item => (
                <div
                  key={item.label}
                  className="qa-item"
                  onDoubleClick={() => onInput(item.command)}
                  title={`双击输入: ${item.command}`}
                >
                  <code className="qa-item-cmd">{item.command}</code>
                  <span className="qa-item-label">{item.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── History Popup ──────────────────────────────────────────────────────── */

function parseHistory(output: string): string[] {
  const lines = output.trim().split('\n')
  const result: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // zsh_history format: ": 1234567890:0;command"
    const zshMatch = trimmed.match(/^:\s*\d+:\d+;(.+)$/)
    if (zshMatch) {
      result.push(zshMatch[1])
      continue
    }
    // bash history with line numbers: "  123  command"
    const numberedMatch = trimmed.match(/^\s*\d+\s+(.+)$/)
    if (numberedMatch) {
      result.push(numberedMatch[1])
      continue
    }
    // plain line (bash_history without numbers)
    result.push(trimmed)
  }
  return result.slice(-200) // keep last 200
}

function HistoryPopup({
  sessionId,
  fmOpen,
  onExecute,
  onInput,
  onClose,
}: {
  sessionId: string
  fmOpen?: boolean
  onExecute: (cmd: string) => void
  onInput: (cmd: string) => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [commands, setCommands] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const output = await invoke<string>('execute_remote_command', {
        sessionId,
        command: 'cat ~/.zsh_history 2>/dev/null || cat ~/.bash_history 2>/dev/null || echo ""',
      })
      setCommands(parseHistory(output))
    } catch (e: any) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [loading])

  return (
    <div className={`qa-popup qa-popup-history${fmOpen ? ' fm-open' : ''}`}>
      <div className="qa-popup-header">
        <span className="qa-popup-title">历史命令</span>
        <button className="qa-popup-close" onClick={onClose} title="关闭">
          <X size={12} strokeWidth={2.5} />
        </button>
      </div>
      <div className="qa-popup-scroll" ref={scrollRef}>
        {loading && (
          <div className="qa-history-loading">
            <Loader2 size={14} className="qa-spin" />
            <span>加载中...</span>
          </div>
        )}
        {error && (
          <div className="qa-history-error">
            <span>{error}</span>
            <button className="qa-history-retry" onClick={loadHistory}>重试</button>
          </div>
        )}
        {!loading && !error && commands.length === 0 && (
          <div className="qa-history-empty">无历史命令</div>
        )}
        {!loading && !error && commands.map((cmd, i) => (
          <div key={`${i}-${cmd}`} className="qa-history-item">
            <code
              className="qa-history-cmd"
              onDoubleClick={() => onInput(cmd)}
              title={cmd}
            >
              {cmd}
            </code>
            <button
              className="qa-history-exec"
              onClick={() => onExecute(cmd)}
              title="执行此命令"
            >
              <Play size={10} strokeWidth={2.5} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
