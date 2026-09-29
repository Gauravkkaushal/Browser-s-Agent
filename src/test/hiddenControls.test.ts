import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The custom toggle/switch: a real <input type="checkbox"> made invisible
 * (opacity:0) with a styled track and thumb drawn over it inside the same
 * <label>. It is visible to a human and clickable by a mouse, but every naive
 * visibility test throws it away -- and with it the only element that carries
 * the checked state.
 *
 * When that happened on an attendance roster, the agent could see the two bulk
 * buttons and none of the fourteen named toggles, so "mark everyone except
 * Gaurav" had no move that could finish: it clicked "Mark all present", failed
 * to find Gaurav's row, clicked "Clear all", and cycled until a human stopped
 * it. These tests pin the fix to the real shipped source.
 */
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../../public/agent-content.js'),
  'utf8',
)

function loadVisibilityHelpers() {
  const start = SOURCE.indexOf('function isVisible(el, rect, style) {')
  const end = SOURCE.indexOf('function isEditable(el) {')
  if (start < 0 || end < 0 || end < start) {
    throw new Error('could not find the visibility helpers in agent-content.js')
  }
  const body = SOURCE.slice(start, end)
  const factory = new Function(
    'window', 'document', 'CSS',
    `${body}\nreturn { isVisible, visualProxy, interactionRect }`,
  )
  const doc = {
    body: { __body: true },
    documentElement: { __root: true },
    querySelector: () => null,
  }
  const win = {
    getComputedStyle: (el: any) => el.style,
    innerWidth: 1280,
    innerHeight: 800,
  }
  return factory(win, doc, { escape: (s: string) => s })
}

type FakeOpts = {
  tag: string
  rect: { left: number; top: number; width: number; height: number }
  style?: Record<string, string>
  attrs?: Record<string, string>
  parent?: any
  label?: any
}

function fake(o: FakeOpts): any {
  const el: any = {
    tagName: o.tag.toUpperCase(),
    id: o.attrs?.id || '',
    style: { display: 'block', visibility: 'visible', opacity: '1', ...(o.style || {}) },
    getBoundingClientRect: () => o.rect,
    getAttribute: (k: string) => (o.attrs && k in o.attrs ? o.attrs[k] : null),
    parentElement: o.parent || null,
    closest: (sel: string) => (sel === 'label' ? o.label || null : null),
  }
  return el
}

describe('visually hidden form controls stay visible to the agent', () => {
  const helpers = loadVisibilityHelpers()

  function switchToggle() {
    // <label class="switch"><input opacity:0 inset:0><span track><span thumb></label>
    const labelRect = { left: 400, top: 300, width: 40, height: 22 }
    const label = fake({ tag: 'label', rect: labelRect })
    const input = fake({
      tag: 'input',
      rect: labelRect, // inset:0 -- same box, but painted at opacity 0
      style: { opacity: '0' },
      attrs: { type: 'checkbox', 'aria-label': 'Gaurav Kumar', id: 'present-2' },
      parent: label,
      label,
    })
    return { input, label, labelRect }
  }

  it('drops a hidden control that has nothing visible standing in for it', () => {
    const orphan = fake({
      tag: 'input',
      rect: { left: 0, top: 0, width: 0, height: 0 },
      style: { opacity: '0' },
      attrs: { type: 'checkbox' },
    })
    expect(helpers.isVisible(orphan)).toBe(false)
    expect(helpers.visualProxy(orphan)).toBeNull()
  })

  it('finds the visible label standing in for an opacity:0 checkbox', () => {
    const { input, label } = switchToggle()
    expect(helpers.isVisible(input)).toBe(false)
    const proxy = helpers.visualProxy(input)
    expect(proxy).not.toBeNull()
    expect(proxy.el).toBe(label)
  })

  it('aims a click at the proxy box, which is where the switch is drawn', () => {
    const { input, labelRect } = switchToggle()
    expect(helpers.interactionRect(input)).toEqual(labelRect)
  })

  it('leaves an ordinary visible control measured by its own box', () => {
    const rect = { left: 10, top: 10, width: 120, height: 32 }
    const button = fake({ tag: 'button', rect })
    expect(helpers.isVisible(button)).toBe(true)
    expect(helpers.interactionRect(button)).toEqual(rect)
  })

  it('refuses a proxy so large it would click something else entirely', () => {
    const form = fake({ tag: 'form', rect: { left: 0, top: 0, width: 900, height: 600 } })
    const input = fake({
      tag: 'input',
      rect: { left: 0, top: 0, width: 0, height: 0 },
      style: { opacity: '0' },
      attrs: { type: 'checkbox' },
      parent: form,
    })
    expect(helpers.visualProxy(input)).toBeNull()
  })
})

describe('the walker keeps proxied controls instead of skipping them', () => {
  it('measures a hidden control by its proxy rather than dropping it', () => {
    expect(SOURCE).toContain('const proxy = visualProxy(el)')
    expect(SOURCE).toMatch(/if \(!proxy\) continue\s*\n\s*rect = proxy\.rect/)
  })

  it('reports a checkbox by its checked state, not its value attribute', () => {
    expect(SOURCE).toContain("value = el.checked ? 'checked' : 'unchecked'")
  })
})
