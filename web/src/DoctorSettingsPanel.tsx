import { useCallback, useEffect, useState } from "react"
import {
  Button,
  Input,
  ProtectedValueField,
  SectionHeader,
  SettingRow,
  Switch,
  UI_COMPONENT_CATALOG,
  useToast,
  type ProtectedValueProtection,
  type ProtectedValueVerification,
} from "@redbamboo/ui"

const BASE = "/api/extensions/doctor"

type RuntimeStatus = {
  enabled?: boolean
  healthy?: boolean
  configuredRevision?: number
  effectiveRevision?: number
  packagedVersion?: string
  effectiveVersion?: string
  port?: number
  url?: string
  tunnelEnabled?: boolean
}

type Field = {
  key: string
  type: "boolean" | "number" | "string" | "secret" | "select" | "action"
  value?: unknown
  configured?: boolean
  protection?: ProtectedValueProtection
  verification?: ProtectedValueVerification
  description?: string
  options?: string[]
}

type Section = { id: string; label: string; fields: Field[] }
type Descriptor = { status: RuntimeStatus; sections: Section[] }
type RotationToast = { title: string; description?: string; variant: "success" | "error" }

// The shell supplies @redbamboo/ui. Hosts built before ProtectedValueField could reveal a
// value ignore `revealedValue`, so the token is then shown in a read-only row under the field.
const fieldRevealsValue = UI_COMPONENT_CATALOG.some((component) =>
  component.id === "protected-value-field" && component.variants.includes("revealed-value"))

/**
 * Rotates the access token, reveals it in the field, then tries to copy it. Copy results
 * are reported as toasts; a failed rotation toasts and rethrows so the field shows the
 * error inline. The token is only handed to `reveal` and `copy`, never logged or stored.
 */
export async function rotateAccessToken({ rotate, reveal, copy, toast }: {
  rotate: () => Promise<string>
  reveal: (token: string) => void
  copy: (token: string) => Promise<void>
  toast: (toast: RotationToast) => void
}) {
  let token: string
  try {
    token = await rotate()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not rotate the access token"
    toast({ title: "Could not rotate the access token", description: message, variant: "error" })
    throw new Error(message)
  }
  reveal(token)
  try {
    await copy(token)
    toast({ title: "New access token copied to clipboard", variant: "success" })
  } catch {
    toast({
      title: "Could not copy the new access token",
      description: "It is shown in the Access Token field. Copy it from there.",
      variant: "error",
    })
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`)
  return body as T
}

export function DoctorSettingsPanel() {
  const [descriptor, setDescriptor] = useState<Descriptor | null>(null)
  const [notice, setNotice] = useState<string>("")
  const [error, setError] = useState<string>("")
  const [rotatedToken, setRotatedToken] = useState("")
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()

  const reload = useCallback(async () => {
    try {
      setDescriptor(await request<Descriptor>("/settings"))
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Doctor settings")
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const save = async (section: string, key: string, value: unknown) => {
    setNotice("")
    setError("")
    try {
      await request("/settings", {
        method: "PUT",
        body: JSON.stringify({ section, values: { [key]: value } }),
      })
      setNotice("Saved and reconciled with Doctor.")
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save Doctor settings")
      throw cause
    }
  }

  const restart = async () => {
    setBusy(true); setNotice(""); setError("")
    try {
      await request("/settings", {
        method: "PUT",
        body: JSON.stringify({ section: "runtime", values: { restart_runtime: true } }),
      })
      setNotice("Doctor restarted and passed its health check.")
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restart Doctor")
    } finally { setBusy(false) }
  }

  const rotate = async () => {
    if (!confirm("Rotate the Doctor access token? Existing bookmarked sessions will stop working.")) return
    // The result appears in the access-token field, so the panel-level notice stays quiet.
    // A failed rotation also hides any earlier token: it may no longer be the active one.
    setBusy(true); setNotice(""); setError(""); setRotatedToken("")
    try {
      await rotateAccessToken({
        rotate: async () => (await request<{ token: string }>("/settings", {
          method: "PUT",
          body: JSON.stringify({ section: "access", values: { rotate_access_token: true } }),
        })).token,
        reveal: setRotatedToken,
        copy: (token) => navigator.clipboard.writeText(token),
        toast,
      })
      await reload()
    } finally { setBusy(false) }
  }

  const status = descriptor?.status
  return <div className="doctor-settings">
    <SectionHeader>Recovery companion</SectionHeader>
    <p className="mb-3 text-xs text-text-muted leading-relaxed">
      Doctor is delivered and configured by RedLeaf, then runs independently so it remains available when the suite needs repair.
    </p>

    <div className="doctor-settings__status" aria-label="Doctor runtime status">
      <Metric label="Runtime" value={!status ? "Checking" : status.healthy ? "Healthy" : status.enabled ? "Unavailable" : "Disabled"} />
      <Metric label="Version" value={status?.effectiveVersion ?? status?.packagedVersion ?? "Unknown"} />
      <Metric label="Port" value={status?.port ? String(status.port) : "Unknown"} />
      <Metric label="Config" value={status?.effectiveRevision === status?.configuredRevision ? `Revision ${status?.configuredRevision}` : "Reconcile pending"} />
    </div>

    <div className="doctor-settings__controls mb-3">
      <Button variant="outline" size="sm" disabled={busy || !descriptor} onClick={() => void restart()}>
        Restart Doctor
      </Button>
      {status?.url && <Button variant="outline" size="sm" onClick={() => window.open(status.url, "_blank", "noopener,noreferrer")}>
        Open locally
      </Button>}
    </div>

    <p aria-live="polite" className={`mb-2 text-xs ${error ? "text-accent-red" : "text-accent-teal"}`}>
      {error || notice}
    </p>

    {descriptor && <DoctorSections sections={descriptor.sections} rotatedToken={rotatedToken} onSave={save} onRotate={rotate} />}
  </div>
}

export function DoctorSections({
  sections,
  rotatedToken,
  onSave,
  onRotate,
}: {
  sections: Section[]
  rotatedToken: string
  onSave: (section: string, key: string, value: unknown) => Promise<void>
  onRotate: () => Promise<void>
}) {
  return <>
    {sections.map((section) => <section key={section.id} data-doctor-section={section.id}>
      <SectionHeader>{section.label}</SectionHeader>
      {section.fields.map((field) => field.type === "action"
        ? null
        : <FieldControl
            key={field.key}
            section={section.id}
            field={field}
            onSave={onSave}
            onRotate={field.key === "access_token" ? onRotate : undefined}
            revealedValue={field.key === "access_token" ? rotatedToken : undefined}
          />)}
    </section>)}
  </>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="doctor-settings__metric"><span>{label}</span><strong>{value}</strong></div>
}

function FieldControl({
  section,
  field,
  onSave,
  onRotate,
  revealedValue,
}: {
  section: string
  field: Field
  onSave: (section: string, key: string, value: unknown) => Promise<void>
  onRotate?: () => Promise<void>
  revealedValue?: string
}) {
  const [draft, setDraft] = useState("")
  useEffect(() => {
    setDraft(field.type === "secret" || field.value == null ? "" : String(field.value))
  }, [field.type, field.value])

  const label = field.key.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ")
  if (field.type === "boolean") {
    return <SettingRow label={label} hint={field.description}>
      <Switch checked={field.value === true} onCheckedChange={(value) => void onSave(section, field.key, value)} />
    </SettingRow>
  }

  if (field.type === "secret") {
    return <>
      <SettingRow label={label} hint={field.description}>
        <ProtectedValueField
          className="w-full"
          kind="token"
          status={{
            configured: field.configured === true,
            protection: field.protection ?? "unknown",
            verification: field.verification ?? "unverified",
          }}
          placeholder={`Enter ${label.toLowerCase()}`}
          onReplace={(value) => onSave(section, field.key, value)}
          onRotate={onRotate}
          onClear={field.key === "tunnel_token"
            ? () => onSave(section, field.key, null)
            : undefined}
          allowClear={field.key === "tunnel_token"}
          revealedValue={revealedValue || null}
        />
      </SettingRow>
      {revealedValue && !fieldRevealsValue && <SettingRow label="New access token" hint="Shown only once. Copy it now.">
        <Input readOnly value={revealedValue} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
      </SettingRow>}
    </>
  }

  if (field.type === "select") {
    return <SettingRow label={label} hint={field.description}>
      <select className="doctor-settings__select" value={String(field.value ?? "")}
        onChange={(event) => void onSave(section, field.key, event.target.value)}>
        {(field.options ?? []).map((option) => <option key={option} value={option}>
          {option === "claude" ? "Claude Code" : option === "codex" ? "Codex" : option}
        </option>)}
      </select>
    </SettingRow>
  }

  const placeholder = field.value == null ? "Auto-detected" : String(field.value)
  return <SettingRow label={label} hint={field.description}>
    <div className="doctor-settings__controls">
      <Input
        type={field.type === "number" ? "number" : "text"}
        className="w-56 h-7 text-xs"
        placeholder={placeholder}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur() }}
      />
      <Button variant="outline" size="sm" disabled={draft === ""}
        onClick={() => void onSave(section, field.key, field.type === "number" ? Number(draft) : draft)}>
        Save
      </Button>
    </div>
  </SettingRow>
}
