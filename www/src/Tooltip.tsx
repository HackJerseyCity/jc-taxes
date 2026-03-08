import { useState, type ReactNode } from 'react'
import {
  useFloating,
  useHover,
  useInteractions,
  offset,
  flip,
  shift,
  autoUpdate,
} from '@floating-ui/react'

type Props = {
  content: ReactNode
  children: ReactNode
}

export default function Tooltip({ content, children }: Props) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const hover = useHover(context, { delay: { open: 200 } })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover])

  return (
    <>
      <span ref={refs.setReference} {...getReferenceProps()}>
        {children}
      </span>
      {open && (
        <div
          ref={refs.setFloating}
          style={{
            ...floatingStyles,
            background: 'var(--panel-bg)',
            color: 'var(--text-primary)',
            border: '1px solid var(--input-border)',
            borderRadius: 4,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.4,
            maxWidth: 260,
            zIndex: 9999,
            pointerEvents: 'none',
          }}
          {...getFloatingProps()}
        >
          {content}
        </div>
      )}
    </>
  )
}
