import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'

export interface FocusOption {
  value: string
  label: string
  group?: string
  /** Extra search terms (portfolio keywords, neighborhood slugs, …). */
  keywords?: string[]
}

// Typeable picker for the focus chip: a label that opens a popover with a
// filter input over grouped options. Substring match on label, group and
// keywords; ↑/↓ + Enter select, Esc / outside-click closes.
export default function FocusPicker({ value, label, options, onChange, fontSize }: {
  value: string
  label: string
  options: FocusOption[]
  onChange: (v: string) => void
  fontSize?: number
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom',
    middleware: [
      offset(6), flip(), shift({ padding: 8 }),
      size({ apply: ({ availableHeight, elements }) => {
        elements.floating.style.maxHeight = `${Math.max(160, Math.min(availableHeight - 8, 520))}px`
      } }),
    ],
    whileElementsMounted: autoUpdate,
  })
  const dismiss = useDismiss(context)
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o =>
      [o.label, o.group ?? '', ...(o.keywords ?? [])].some(t => t.toLowerCase().includes(q)),
    )
  }, [options, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const i = options.findIndex(o => o.value === value)
    setActive(Math.max(0, i))
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, options, value])
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])

  const pick = (o: FocusOption | undefined) => {
    if (!o) return
    onChange(o.value)
    setOpen(false)
  }

  let lastGroup: string | undefined
  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps({ onClick: () => setOpen(o => !o) })}
        title="Highlight a developer portfolio, ward, or neighborhood"
        aria-label="Focus"
        aria-expanded={open}
        style={{
          pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.25em',
          background: 'transparent', color: 'white', border: 'none', padding: 0, margin: 0,
          borderBottom: '1px dotted rgba(255,255,255,0.7)', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: fontSize ?? 'inherit', fontWeight: 600, whiteSpace: 'nowrap',
          maxWidth: '55vw',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ fontSize: '0.55em', opacity: 0.85 }}>{'▼'}</span>
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            {...getFloatingProps()}
            style={{
              ...floatingStyles, zIndex: 20, width: 'min(320px, 92vw)',
              display: 'flex', flexDirection: 'column',
              background: 'var(--panel-bg)', color: 'var(--text-primary)',
              border: '1px solid var(--input-border)', borderRadius: 8,
              boxShadow: '0 6px 24px var(--shadow)', fontFamily: 'Inter, sans-serif', fontSize: 14,
            }}
          >
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
                else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[active]) }
                else if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
                e.stopPropagation()
              }}
              placeholder="Filter: developer, ward, neighborhood…"
              aria-label="Filter focus options"
              style={{
                margin: 8, padding: '6px 8px', fontSize: 16, borderRadius: 6,
                background: 'var(--input-bg)', color: 'var(--text-primary)',
                border: '1px solid var(--input-border)', outline: 'none',
              }}
            />
            <div ref={listRef} role="listbox" style={{ overflowY: 'auto', padding: '0 4px 6px' }}>
              {filtered.length === 0 && (
                <div style={{ padding: '6px 10px', color: 'var(--text-secondary)' }}>No matches</div>
              )}
              {filtered.map((o, i) => {
                const header = o.group && o.group !== lastGroup
                lastGroup = o.group
                return (
                  <div key={o.value}>
                    {header && (
                      <div style={{ padding: '8px 10px 2px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-secondary)' }}>
                        {o.group}
                      </div>
                    )}
                    <div
                      data-idx={i}
                      role="option"
                      aria-selected={o.value === value}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(o)}
                      style={{
                        padding: '5px 10px', borderRadius: 5, cursor: 'pointer',
                        background: i === active ? 'var(--input-bg)' : 'transparent',
                        fontWeight: o.value === value ? 700 : 400,
                      }}
                    >
                      {o.label}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
