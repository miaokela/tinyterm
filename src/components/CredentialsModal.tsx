import { useState } from 'react'
import { X, Plus, Pencil, Trash2, KeyRound, Lock, ShieldCheck, AlertCircle, Eye, EyeOff } from 'lucide-react'
import { useStore } from '../store'
import type { Profile } from '../types'
import './CredentialsModal.css'

export function CredentialsModal() {
  const {
    credentialsModalOpen,
    closeCredentialsModal,
    credentials,
    createProfile,
    updateProfile,
    deleteProfile,
    openConfirmDialog,
  } = useStore()

  const [editingCredential, setEditingCredential] = useState<Profile | null>(null)
  const [formOpen, setFormOpen] = useState(false)

  if (!credentialsModalOpen) return null

  const handleEdit = (c: Profile) => {
    setEditingCredential(c)
    setFormOpen(true)
  }

  const handleDelete = async (id: string) => {
    const confirmed = await openConfirmDialog({
      title: '删除 Credential',
      message: '确认删除该认证配置？',
      confirmText: '删除',
      cancelText: '取消',
    })
    if (!confirmed) return
    await deleteProfile(id)
  }

  const handleSave = async (data: Omit<Profile, 'id' | 'created_at' | 'password_encrypted'>) => {
    if (editingCredential) {
      await updateProfile({ ...editingCredential, ...data, password_encrypted: false })
    } else {
      await createProfile(data)
    }
    setFormOpen(false)
    setEditingCredential(null)
  }

  return (
    <div className="modal-overlay">
      <div className="cm-shell">
        {/* Header */}
        <div className="cm-header">
          <div className="cm-header-left">
            <ShieldCheck size={18} strokeWidth={1.8} />
            <span>Credentials</span>
          </div>
          <button className="cm-close-btn" onClick={closeCredentialsModal}>
            <X size={16} />
          </button>
        </div>

        {/* Action bar */}
        <div className="cm-action-bar">
          <p className="cm-hint">可复用的认证配置，在 Hosts 中选择引用。</p>
          <button
            className="cm-add-btn"
            onClick={() => { setEditingCredential(null); setFormOpen(true) }}
            title="新建 Credential"
            aria-label="新建 Credential"
          >
            <Plus size={15} strokeWidth={2.4} />
          </button>
        </div>

        {/* List */}
        <div className="cm-list">
          {credentials.length === 0 ? (
            <div className="cm-empty">
              <KeyRound size={32} strokeWidth={1} className="cm-empty-icon" />
              <p>暂无认证配置</p>
            </div>
          ) : (
            credentials.map(c => (
              <CredentialRow
                key={c.id}
                credential={c}
                onEdit={() => handleEdit(c)}
                onDelete={() => handleDelete(c.id)}
              />
            ))
          )}
        </div>
      </div>

      {formOpen && (
        <CredentialForm
          credential={editingCredential}
          onSave={handleSave}
          onCancel={() => { setFormOpen(false); setEditingCredential(null) }}
        />
      )}
    </div>
  )
}

// ── Credential Row ────────────────────────────────────────────────────────────

function CredentialRow({
  credential, onEdit, onDelete,
}: {
  credential: Profile
  onEdit: () => void
  onDelete: () => void
}) {
  const isKey = credential.auth_type === 'privateKey'

  return (
    <div className="cm-row">
      <div className="cm-row-icon">
        {isKey
          ? <KeyRound size={16} strokeWidth={1.8} />
          : <Lock size={16} strokeWidth={1.8} />}
      </div>
      <div className="cm-row-info">
        <div className="cm-row-name">{credential.title}</div>
        <div className="cm-row-meta">
          <span className="cm-row-user">{credential.username}</span>
          <span className="cm-row-type-badge">{isKey ? 'Private Key' : 'Password'}</span>
        </div>
      </div>
      <div className="cm-row-actions">
        <button className="cm-icon-btn" onClick={onEdit} title="编辑">
          <Pencil size={14} strokeWidth={1.8} />
        </button>
        <button className="cm-icon-btn danger" onClick={onDelete} title="删除">
          <Trash2 size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}

// ── Credential Form ───────────────────────────────────────────────────────────

type CredentialFormData = Omit<Profile, 'id' | 'created_at' | 'password_encrypted'>

export function CredentialForm({
  credential, onSave, onCancel,
}: {
  credential: Profile | null
  onSave: (data: CredentialFormData) => Promise<void>
  onCancel: () => void
}) {
  const [showPassword, setShowPassword] = useState(false)
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [form, setForm] = useState<CredentialFormData>({
    title: credential?.title ?? '',
    username: credential?.username ?? '',
    auth_type: credential?.auth_type ?? 'password',
    password: '',
    private_key: credential?.private_key ?? '',
    passphrase: credential?.passphrase ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const update = <K extends keyof CredentialFormData>(key: K, value: CredentialFormData[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    if (!form.title.trim()) { setError('请填写配置名称'); return }
    if (!form.username.trim()) { setError('请填写用户名'); return }
    setError(undefined)
    setSaving(true)
    try { await onSave(form) } catch (e: any) { setError(String(e)) } finally { setSaving(false) }
  }

  return (
    <div className="modal-overlay" style={{ zIndex: 200 }}>
      <div className="cf-shell">
        {/* Header */}
        <div className="cm-header">
          <div className="cm-header-left">
            <ShieldCheck size={16} strokeWidth={1.8} />
            <span>{credential ? '编辑 Credential' : '新建 Credential'}</span>
          </div>
          <button className="cm-close-btn" onClick={onCancel}><X size={16} /></button>
        </div>

        <div className="cf-body">
          {/* Name */}
          <div className="cf-field full">
            <label className="cf-label">配置名称 *</label>
            <input
              className="form-input"
              placeholder="例如: Production Root Key"
              value={form.title}
              onChange={e => update('title', e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </div>

          {/* Username */}
          <div className="cf-field full">
            <label className="cf-label">用户名 *</label>
            <input
              className="form-input"
              placeholder="root"
              value={form.username}
              onChange={e => update('username', e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {/* Auth type toggle */}
          <div className="cf-field full">
            <label className="cf-label">认证方式</label>
            <div className="cf-auth-toggle">
              <button
                type="button"
                className={`cf-auth-opt${form.auth_type === 'password' ? ' active' : ''}`}
                onClick={() => update('auth_type', 'password')}
              >
                <Lock size={13} strokeWidth={2} />
                密码
              </button>
              <button
                type="button"
                className={`cf-auth-opt${form.auth_type === 'privateKey' ? ' active' : ''}`}
                onClick={() => update('auth_type', 'privateKey')}
              >
                <KeyRound size={13} strokeWidth={2} />
                私钥
              </button>
            </div>
          </div>

          {/* Password */}
          {form.auth_type === 'password' && (
            <div className="cf-field full">
              <label className="cf-label">密码</label>
              <div className="cf-secret-field">
                <input
                  className="form-input cf-secret-input"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={credential ? '留空则保持原密码' : '登录密码'}
                  value={form.password ?? ''}
                  onChange={e => update('password', e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="cf-secret-toggle"
                  onClick={() => setShowPassword(value => !value)}
                  title={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff size={14} strokeWidth={1.9} /> : <Eye size={14} strokeWidth={1.9} />}
                </button>
              </div>
            </div>
          )}

          {/* Private key */}
          {form.auth_type === 'privateKey' && (
            <>
              <div className="cf-field full">
                <label className="cf-label">私钥内容</label>
                <textarea
                  className="form-input cf-textarea"
                  rows={6}
                  placeholder={credential ? '留空则保持原私钥' : '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----'}
                  value={form.private_key ?? ''}
                  onChange={e => update('private_key', e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div className="cf-field full">
                <label className="cf-label">私钥密码（可选）</label>
                <div className="cf-secret-field">
                  <input
                    className="form-input cf-secret-input"
                    type={showPassphrase ? 'text' : 'password'}
                    placeholder={credential ? '留空则保持原私钥密码' : '私钥保护密码'}
                    value={form.passphrase ?? ''}
                    onChange={e => update('passphrase', e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="cf-secret-toggle"
                    onClick={() => setShowPassphrase(value => !value)}
                    title={showPassphrase ? '隐藏私钥密码' : '显示私钥密码'}
                  >
                    {showPassphrase ? <EyeOff size={14} strokeWidth={1.9} /> : <Eye size={14} strokeWidth={1.9} />}
                  </button>
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="cf-error">
              <AlertCircle size={13} />
              {error}
            </div>
          )}
        </div>

        <div className="cf-footer">
          <div className="cf-footer-group">
            <button className="btn-ghost" onClick={onCancel} disabled={saving}>取消</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : credential ? '更新' : '创建'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}