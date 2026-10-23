import assert from "node:assert/strict"
import { after, before, test } from "node:test"
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
const render = (rotation) => renderToStaticMarkup(
  createElement(panel.DoctorSections, { sections, rotation, onSave: noop, onRotate: noop }))

/** Splits markup into the slices owned by each settings section. */
function sectionsOf(html) {
  const result = {}
  for (const match of html.matchAll(/<section data-doctor-section="([^"]+)">([\s\S]*?)<\/section>/g)) result[match[1]] = match[2]
  return result
}

test("a rotated token renders inline in the Access section, after the Rotate control", () => {
  const html = render({ token: TOKEN, error: "" })
  const { runtime, access, tunnel } = sectionsOf(html)
  assert.equal(html.split(TOKEN).length - 1, 1, "token is rendered exactly once")
  assert.ok(access.includes(TOKEN), "token lives in the Access section")
  assert.ok(!runtime.includes(TOKEN) && !tunnel.includes(TOKEN))

  const field = access.indexOf('data-slot="protected-value-field"')
  const rotateButton = access.indexOf(">Rotate<")
  const result = access.indexOf('data-slot="doctor-rotated-token"')
  assert.ok(field >= 0 && rotateButton > field, "access field exposes Rotate")
  assert.ok(result > rotateButton, "result follows the Rotate button")
  assert.equal(access.match(/data-slot="protected-value-field"/g).length, 1, "no other field between Rotate and the result")
})

test("the rotated token is a focusable, labelled region with a Copy action and position-neutral wording", () => {
  const html = renderToStaticMarkup(createElement(panel.RotationResult, { token: TOKEN, error: "" }))
  assert.match(html, /role="region"/)
  assert.match(html, /tabindex="-1"/)
  assert.match(html, /aria-labelledby="[^"]+"/)
  assert.match(html, /aria-describedby="[^"]+"/)
  assert.match(html, /<button[^>]*>Copy token<\/button>/)
  assert.match(html, /New access token/)
  assert.match(html, /Shown only once/)
  assert.doesNotMatch(html, /\b(below|above)\b/i, "wording must not depend on layout direction")
})

test("a rotation error renders in the Access section as an alert instead of a token", () => {
  const html = render({ token: "", error: "Doctor rejected the rotation" })
  const { runtime, access } = sectionsOf(html)
  assert.ok(access.includes("Doctor rejected the rotation"))
  assert.ok(!runtime.includes("Doctor rejected the rotation"))
  assert.match(access, /<p role="alert"[^>]*>Doctor rejected the rotation<\/p>/)
  assert.ok(access.indexOf('data-slot="doctor-rotation-error"') > access.indexOf(">Rotate<"))
  assert.doesNotMatch(html, /doctor-rotated-token/)
})

test("nothing is rendered beside the field before a rotation", () => {
  const html = render({ token: "", error: "" })
  assert.doesNotMatch(html, /doctor-rotated-token|doctor-rotation-error/)
  assert.ok(sectionsOf(html).access.includes(">Rotate<"))
})
