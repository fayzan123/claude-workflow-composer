import React, { useState, useEffect } from 'react'
import { api } from '../../lib/api.ts'

export function SettingsBlock() {
  const [config, setConfig] = useState<{ notifications: { macos: boolean; webhookUrl?: string } } | null>(null)
  const [webhookInput, setWebhookInput] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.automations.config().then(c => {
      setConfig(c)
      setWebhookInput(c.notifications.webhookUrl ?? '')
    }).catch(() => {})
  }, [])

  async function toggle(key: 'macos') {
    if (!config) return
    const next = { ...config, notifications: { ...config.notifications, [key]: !config.notifications[key] } }
    setConfig(next)
    setSaving(true)
    await api.automations.setConfig(next).catch(() => {})
    setSaving(false)
  }

  async function saveWebhook() {
    if (!config) return
    const next = { ...config, notifications: { ...config.notifications, webhookUrl: webhookInput || undefined } }
    setConfig(next)
    setSaving(true)
    await api.automations.setConfig(next).catch(() => {})
    setSaving(false)
  }

  if (!config) return <div className="run-panel__settings-loading">Loading…</div>

  return (
    <div className="run-panel__settings">
      <label className="run-panel__settings-row">
        <span>macOS notifications</span>
        <input type="checkbox" checked={config.notifications.macos} onChange={() => toggle('macos')} />
      </label>
      <label className="run-panel__settings-row">
        <span>Webhook URL</span>
      </label>
      <div className="run-panel__settings-webhook">
        <input
          type="url"
          placeholder="https://hooks.slack.com/…"
          value={webhookInput}
          onChange={e => setWebhookInput(e.target.value)}
          className="run-panel__settings-input"
        />
        <button type="button" onClick={saveWebhook} disabled={saving} className="run-panel__settings-save">
          {saving ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
