import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createServer } from "vite"

const root = fileURLToPath(new URL("..", import.meta.url))
const TOKEN = "rotated-token-0123456789abcdefghijklmnop"

// Mirrors the sections DoctorSettingsProvider describes around Access.
const sections = [
  { id: "runtime", label: "Runtime", fields: [
    { key: "enabled", type: "boolean", value: true },
    { key: "restart_runtime", type: "action" },
  ] },
  { id: "access", label: "Access", fields: [
    { key: "access_token", type: "secret", configured: true, protection: "encrypted", description: "Authenticates the standalone recovery dashboard." },
    { key: "rotate_access_token", type: "action" },
  ] },
  { id: "tunnel", label: "Cloudflare Tunnel", fields: [
    { key: "tunnel_token", type: "secret", configured: false, protection: "encrypted" },
  ] },
]

let server
let panel

before(async () => {
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    // @redbamboo/ui is linked from its own checkout; keep its React-based dependencies on
    // this package's single React instance.
    resolve: { dedupe: ["react", "react-dom"] },
    ssr: { noExternal: [/^@redbamboo\//, /^@base-ui\//] },
  })
  panel = await server.ssrLoadModule("/src/DoctorSettingsPanel.tsx")
})

after(async () => { await server?.close() })

const noop = async () => {}
const render = (rotatedToken) => renderToStaticMarkup(
  createElement(panel.DoctorSections, { sections, rotatedToken, onSave: noop, onRotate: noop }))

/** Splits markup into the slices owned by each settings section. */
function sectionsOf(html) {
  const result = {}
  for (const match of html.matchAll(/<section data-doctor-section="([^"]+)">([\s\S]*?)<\/section>/g)) result[match[1]] = match[2]
  return result
}

test("a rotated token is revealed inside the access-token field itself", () => {
  const html = render(TOKEN)
  const { runtime, access, tunnel } = sectionsOf(html)
  assert.equal(html.split(TOKEN).length - 1, 1, "token is rendered exactly once")
  assert.ok(!runtime.includes(TOKEN) && !tunnel.includes(TOKEN))

  // Field card, then the revealed value, then the card's action bar with Copy and Rotate.
  const field = access.indexOf('data-slot="protected-value-field"')
  const value = access.indexOf(TOKEN)
  const copy = access.indexOf('data-slot="protected-value-copy"')
  const rotate = access.indexOf(">Rotate<")
  assert.ok(field >= 0 && field < value && value < copy && copy < rotate, "value and Copy sit inside the field card")
  assert.match(access.slice(field, value), /data-revealed="true"/)
  assert.equal(access.match(/data-slot="protected-value-field"/g).length, 1)
  assert.doesNotMatch(tunnel, /data-revealed/, "the tunnel token field is not revealed")
  assert.doesNotMatch(html, /doctor-rotated-token|doctor-settings__token/, "no separate token box")
})

test("the revealed token is the design-system Input, labelled, focusable, with a short notice", () => {
  const { access } = sectionsOf(render(TOKEN))
  const input = access.match(/<input[^>]*data-slot="protected-value-revealed-value"[^>]*>/)?.[0]
  assert.ok(input)
  assert.match(input, /readOnly=""/)
  assert.match(input, /aria-label="New token"/)
  assert.match(input, new RegExp(`value="${TOKEN}"`))
  const noticeId = input.match(/aria-describedby="([^"]+)"/)?.[1]
  assert.ok(noticeId)
  assert.match(access, new RegExp(`id="${noticeId}"[^>]*>Shown only once\\. Copy it now\\.<`))
  assert.match(access, /<button[^>]*data-slot="protected-value-copy"[^>]*>.*Copy token<\/button>/)
  assert.doesNotMatch(access, /\b(below|above)\b/i, "wording must not depend on layout direction")
  assert.doesNotMatch(access, />New access token</, "capable hosts do not render the fallback row")
})

test("the panel ships no bespoke token styling", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8")
  assert.doesNotMatch(css, /token|rotation|reveal/i)
})

test("nothing is revealed before a rotation", () => {
  const html = render("")
  assert.doesNotMatch(html, /data-revealed|protected-value-revealed|protected-value-copy/)
  assert.ok(sectionsOf(html).access.includes(">Rotate<"))
})

function harness({ rotate = async () => TOKEN, copy = async () => {} } = {}) {
  const calls = []
  return {
    calls,
    effects: {
      rotate: async () => { calls.push("rotate"); return rotate() },
      reveal: (token) => calls.push(["reveal", token]),
      copy: async (token) => { calls.push(["copy", token]); return copy(token) },
      toast: (toast) => calls.push(["toast", toast]),
    },
  }
}

test("a successful rotation reveals the token, copies it, and confirms with a toast", async () => {
  const { calls, effects } = harness()
  await panel.rotateAccessToken(effects)
  assert.deepEqual(calls, [
    "rotate",
    ["reveal", TOKEN],
    ["copy", TOKEN],
    ["toast", { title: "New access token copied to clipboard", variant: "success" }],
  ])
})

test("a failed automatic copy keeps the token revealed and says so in a toast", async () => {
  const { calls, effects } = harness({ copy: async () => { throw new DOMException("Document is not focused.", "NotAllowedError") } })
  await panel.rotateAccessToken(effects)
  assert.deepEqual(calls.slice(0, 3), ["rotate", ["reveal", TOKEN], ["copy", TOKEN]])
  const [, toast] = calls[3]
  assert.equal(toast.variant, "error")
  assert.equal(toast.title, "Could not copy the new access token")
  assert.match(toast.description, /shown in the Access Token field/)
  assert.ok(!JSON.stringify(toast).includes(TOKEN), "the token never appears in a toast")
})

test("a missing clipboard API is treated as a failed copy, not a failed rotation", async () => {
  const { calls, effects } = harness({ copy: async () => undefined.writeText(TOKEN) })
  await panel.rotateAccessToken(effects)
  assert.equal(calls.at(-1)[1].title, "Could not copy the new access token")
})

test("a failed rotation toasts and rethrows so the field shows the error inline", async () => {
  const { calls, effects } = harness({ rotate: async () => { throw new Error("Doctor rejected the rotation") } })
  await assert.rejects(panel.rotateAccessToken(effects), { message: "Doctor rejected the rotation" })
  assert.deepEqual(calls, [
    "rotate",
    ["toast", { title: "Could not rotate the access token", description: "Doctor rejected the rotation", variant: "error" }],
  ])
})
