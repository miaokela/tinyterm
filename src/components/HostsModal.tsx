import { useState } from 'react'
import './HostsModal.css'
import {
  X, Plus, PlugZap, Pencil, Trash2, Server, Search, ChevronRight, AlertCircle, Copy,
} from 'lucide-react'
import { useStore } from '../store'
import { CredentialForm } from './CredentialsModal'
import type { Bookmark, Profile } from '../types'

type HostFormData = {
  title: string
  host: string
  port: number
  profile_id: string   // optional — links a Credential if set
  username: string      // used directly when no credential is selected
  color: string
  description: string
  start_directory_remote: string
  term: string
  encode: string
  enable_sftp: boolean
  keepalive_interval: number
  auth_type: 'profile'
  password: string | undefined
  private_key: string | undefined
  passphrase: string | undefined
  group_id: string | undefined
  start_directory_local: string
}

function defaultForm(host?: Bookmark): HostFormData {
  return {
    title: host?.title ?? '',
    host: host?.host ?? '',
    port: host?.port ?? 22,
    profile_id: host?.profile_id ?? '',
    color: host?.color ?? '#7c5cbf',
    description: host?.description ?? '',
    start_directory_remote: host?.start_directory_remote ?? '',
    term: host?.term ?? 'xterm-256color',
    encode: host?.encode ?? 'utf8',
    enable_sftp: host?.enable_sftp ?? true,
    keepalive_interval: host?.keepalive_interval ?? 30000,
    username: host?.username ?? '',
    auth_type: 'profile',
    password: undefined,
    private_key: undefined,
    passphrase: undefined,
    group_id: host?.group_id ?? undefined,
    start_directory_local: host?.start_directory_local ?? '',
  }
}

export function HostsModal() {
  const {
    hostsModalOpen,
    closeHostsModal,
    hosts,
    hostReachabilityById,
    credentials,
    createBookmark,
    updateBookmark,
    deleteBookmark,
    openHostTab,
    openConfirmDialog,
  } = useStore()

  const [editingHost, setEditingHost] = useState<Bookmark | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null)

  if (!hostsModalOpen) return null

  const filtered = filter
    ? hosts.filter(h =>
        (h.title || '').toLowerCase().includes(filter.toLowerCase()) ||
        h.host.toLowerCase().includes(filter.toLowerCase())
      )
    : hosts

  const handleConnect = async (hostId: string) => {
    setConnectingHostId(hostId)
    // 强制让 React 先渲染 loading 状态到 UI 上
    await new Promise(resolve => setTimeout(resolve, 50))
    try {
      await openHostTab(hostId)
    } finally {
      setConnectingHostId(null)
    }
  }

  const handleEdit = (h: Bookmark) => {
    setEditingHost(h)
    setFormOpen(true)
  }

  const handleDuplicate = (h: Bookmark) => {
    // Open form pre-filled with the host's data, but editingHost=null so it creates new
    setEditingHost({ ...h, id: '', title: h.title ? h.title + ' (副本)' : '' } as any)
    setFormOpen(true)
  }

  const handleDelete = async (id: string) => {
    const confirmed = await openConfirmDialog({
      title: '删除 Host',
      message: '确认删除该主机？',
      confirmText: '删除',
      cancelText: '取消',
    })
    if (!confirmed) return
    await deleteBookmark(id)
  }

  const handleSave = async (data: HostFormData) => {
    // Resolve username: prefer credential's username, fallback to form field
    const cred = credentials.find(c => c.id === data.profile_id)
    const resolved: Omit<Bookmark, 'id' | 'created_at' | 'updated_at' | 'password_encrypted'> = {
      ...data,
      username: cred?.username ?? data.username ?? '',
      auth_type: 'profile',
    }
    if (editingHost && editingHost.id) {
      // Update existing
      await updateBookmark({ ...editingHost, ...resolved, password_encrypted: false })
    } else {
      // Create new (including duplicate)
      await createBookmark(resolved)
    }
    setFormOpen(false)
    setEditingHost(null)
  }

  return (
    <div className="modal-overlay">
      <div className="hm-shell">
        {/* Header */}
        <div className="hm-header">
          <div className="hm-header-left">
            <Server size={18} strokeWidth={1.8} />
            <span>Hosts</span>
          </div>
          <button className="hm-close-btn" onClick={closeHostsModal}>
            <X size={16} />
          </button>
        </div>

        {/* Toolbar */}
        <div className="hm-toolbar">
          <div className="hm-search-wrap">
            <Search size={13} className="hm-search-icon" />
            <input
              className="hm-search-input"
              placeholder="搜索主机名 / IP..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <button
            className="hm-add-btn"
            onClick={() => { setEditingHost(null); setFormOpen(true) }}
            aria-label="新建 Host"
          >
            <Plus size={15} strokeWidth={2.4} />
          </button>
        </div>

        {/* List */}
        <div className="hm-list">
          {filtered.length === 0 ? (
            <div className="hm-empty">
              {filter ? '未找到匹配主机' : '暂无主机'}
            </div>
          ) : (
            filtered.map(h => {
              const cred = credentials.find(c => c.id === h.profile_id)
              return (
                <HostRow
                  key={h.id}
                  host={h}
                  unreachable={hostReachabilityById[h.id] === 'unreachable'}
                  credential={cred}
                  connecting={connectingHostId === h.id}
                  onConnect={() => handleConnect(h.id)}
                  onEdit={() => handleEdit(h)}
                  onDuplicate={() => handleDuplicate(h)}
                  onDelete={() => handleDelete(h.id)}
                />
              )
            })
          )}
        </div>
      </div>

      {formOpen && (
        <HostForm
          host={editingHost}
          credentials={credentials}
          onSave={handleSave}
          onCancel={() => { setFormOpen(false); setEditingHost(null) }}
        />
      )}
    </div>
  )
}

// ── Host Row ──────────────────────────────────────────────────────────────────

function HostRow({
  host, unreachable, credential, connecting, onConnect, onEdit, onDuplicate, onDelete,
}: {
  host: Bookmark
  unreachable: boolean
  credential?: Profile
  connecting: boolean
  onConnect: () => Promise<void>
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const dot = host.color || '#7c5cbf'

  return (
    <div className={`hm-row ${unreachable ? 'is-unreachable' : ''}`}>
      <span className="hm-row-dot" style={{ background: dot, boxShadow: `0 0 6px ${dot}99` }} />

      <div className="hm-row-info">
        <div className="hm-row-name">{host.title || host.host}</div>
        <div className="hm-row-meta">
          <span className="hm-row-addr">{host.host}:{host.port}</span>
          {credential ? (
            <span className="hm-row-cred-badge">
              {credential.auth_type === 'privateKey' ? 'key' : 'pwd'} · {credential.title}
            </span>
          ) : host.username ? (
            <span className="hm-row-cred-badge" style={{ opacity: 0.7 }}>
              {host.username} · 手动输入
            </span>
          ) : (
            <span className="hm-row-cred-badge" style={{ opacity: 0.5 }}>
              连接时输入
            </span>
          )}
        </div>
      </div>

      <div className="hm-row-actions">
        <button
          className={`hm-connect-btn${connecting ? ' is-loading' : ''}`}
          onClick={onConnect}
          title="连接"
          aria-label="连接"
          disabled={connecting}
        >
          {connecting ? (
            <span className="hm-connect-spinner" />
          ) : (
            <PlugZap size={15} strokeWidth={2.2} />
          )}
        </button>
        <button className="hm-icon-btn" onClick={onEdit} title="编辑" disabled={connecting}>
          <Pencil size={14} strokeWidth={1.8} />
        </button>
        <button className="hm-icon-btn" onClick={onDuplicate} title="复制" disabled={connecting}>
          <Copy size={14} strokeWidth={1.8} />
        </button>
        <button className="hm-icon-btn danger" onClick={onDelete} title="删除" disabled={connecting}>
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}

// ── Host Form ─────────────────────────────────────────────────────────────────

function HostForm({
  host, credentials, onSave, onCancel,
}: {
  host: Bookmark | null
  credentials: Profile[]
  onSave: (data: HostFormData) => Promise<void>
  onCancel: () => void
}) {
  const [form, setForm] = useState<HostFormData>(defaultForm(host ?? undefined))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [credFormOpen, setCredFormOpen] = useState(false)
  const [editingCred, setEditingCred] = useState<Profile | null>(null)
  const { createProfile, updateProfile, deleteProfile, openConfirmDialog } = useStore()

  const isDuplicate = host ? !host.id : false
  const formTitle = isDuplicate ? '复制 Host' : host ? '编辑 Host' : '新建 Host'

  const set = <K extends keyof HostFormData>(key: K, val: HostFormData[K]) =>
    setForm(prev => ({ ...prev, [key]: val }))

  const selectedCred = credentials.find(c => c.id === form.profile_id)

  const handleSave = async () => {
    if (!form.host.trim()) { setError('请填写主机地址'); return }
    setError(undefined)
    setSaving(true)
    try { await onSave(form) } catch (e: any) { setError(String(e)) } finally { setSaving(false) }
  }

  const handleCredSave = async (data: Omit<Profile, 'id' | 'created_at' | 'password_encrypted'>) => {
    if (editingCred) {
      await updateProfile({ ...editingCred, ...data, password_encrypted: false })
    } else {
      await createProfile(data)
    }
    setCredFormOpen(false)
    setEditingCred(null)
  }

  const handleCredDelete = async (id: string) => {
    const confirmed = await openConfirmDialog({
      title: '删除 Credential',
      message: '确认删除该认证配置？',
      confirmText: '删除',
      cancelText: '取消',
    })
    if (!confirmed) return
    await deleteProfile(id)
    // 若被删除的是当前选中的凭证，清空选择
    if (form.profile_id === id) set('profile_id', '')
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 200 }}>
      <div className="hf-shell">
        <div className="hm-header">
          <div className="hm-header-left">
            <Server size={16} strokeWidth={1.8} />
            <span>{formTitle}</span>
          </div>
          <button className="hm-close-btn" onClick={onCancel}><X size={16} /></button>
        </div>

        <div className="hf-body">
          {/* Name */}
          <div className="hf-field full">
            <label className="hf-label">名称（可选）</label>
            <input className="form-input" placeholder="My Production Server"
              value={form.title} onChange={e => set('title', e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus />
          </div>

          {/* Host + Port */}
          <div className="hf-row">
            <div className="hf-field" style={{ flex: 3 }}>
              <label className="hf-label">主机地址 *</label>
              <input className="form-input" placeholder="192.168.1.1 / example.com"
                value={form.host} onChange={e => set('host', e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
            <div className="hf-field" style={{ flex: 1 }}>
              <label className="hf-label">端口</label>
              <input className="form-input" type="number" min={1} max={65535}
                value={form.port} onChange={e => set('port', parseInt(e.target.value) || 22)} />
            </div>
          </div>

          {/* Credential — managed list with CRUD */}
          <div className="hf-field full">
            <div className="hf-cred-header">
              <label className="hf-label">Credential（可选）</label>
              <button
                className="hf-cred-add"
                type="button"
                onClick={() => { setEditingCred(null); setCredFormOpen(true) }}
                title="新建 Credential"
                aria-label="新建 Credential"
              >
                <Plus size={13} strokeWidth={2.4} />
                <span>新增</span>
              </button>
            </div>
            {credentials.length === 0 ? (
              <div className="hf-no-cred" style={{ opacity: 0.7 }}>
                暂无 Credential，连接时将提示输入用户名和密码
              </div>
            ) : (
              <div className="hf-cred-list">
                {credentials.map(c => (
                  <div
                    key={c.id}
                    className={`hf-cred-item${form.profile_id === c.id ? ' selected' : ''}`}
                  >
                    <button
                      className="hf-cred-select"
                      type="button"
                      onClick={() => set('profile_id', form.profile_id === c.id ? '' : c.id)}
                    >
                      <span className="hf-cred-dot">
                        {c.auth_type === 'privateKey' ? 'KEY' : 'PWD'}
                      </span>
                      <span className="hf-cred-name">{c.title}</span>
                      <span className="hf-cred-user">{c.username}</span>
                      {form.profile_id === c.id && (
                        <ChevronRight size={13} className="hf-cred-check" />
                      )}
                    </button>
                    <div className="hf-cred-actions">
                      <button
                        className="hf-cred-action"
                        type="button"
                        title="编辑"
                        aria-label="编辑 Credential"
                        onClick={() => { setEditingCred(c); setCredFormOpen(true) }}
                      >
                        <Pencil size={12} strokeWidth={1.8} />
                      </button>
                      <button
                        className="hf-cred-action danger"
                        type="button"
                        title="删除"
                        aria-label="删除 Credential"
                        onClick={() => handleCredDelete(c.id)}
                      >
                        <Trash2 size={12} strokeWidth={1.8} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {selectedCred && (
              <div className="hf-cred-resolved">
                将使用用户名 <code>{selectedCred.username}</code>，
                认证方式：{selectedCred.auth_type === 'privateKey' ? '私钥' : '密码'}
              </div>
            )}
          </div>

          {/* Remote start dir */}
          <div className="hf-field full">
            <label className="hf-label">远程初始目录（可选）</label>
            <input className="form-input" placeholder="/home/user"
              value={form.start_directory_remote}
              onChange={e => set('start_directory_remote', e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </div>

          {/* Color + Description */}
          <div className="hf-row">
            <div className="hf-field" style={{ flex: 1 }}>
              <label className="hf-label">标签颜色</label>
              <input type="color" className="form-input hf-color-input"
                value={form.color} onChange={e => set('color', e.target.value)} />
            </div>
            <div className="hf-field" style={{ flex: 3 }}>
              <label className="hf-label">备注</label>
              <input className="form-input" placeholder="可选"
                value={form.description} onChange={e => set('description', e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
          </div>

          {error && (
            <div className="hf-error">
              <AlertCircle size={13} />
              {error}
            </div>
          )}
        </div>

        <div className="hf-footer">
          <div className="hf-footer-group">
            <button className="btn-ghost" onClick={onCancel} disabled={saving}>取消</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : (host && host.id) ? '更新' : '创建'}
            </button>
          </div>
        </div>
      </div>

      {credFormOpen && (
        <CredentialForm
          credential={editingCred}
          onSave={handleCredSave}
          onCancel={() => { setCredFormOpen(false); setEditingCred(null) }}
        />
      )}
    </div>
  )
}