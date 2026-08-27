import { type ReactNode } from 'react'
import { useHotkeysContext, SpeedDial } from 'use-kbd'
import { FaGithub } from 'react-icons/fa'
import { SiBluesky } from 'react-icons/si'
import { MdDarkMode, MdLightMode, MdKeyboard, MdSettingsBrightness } from 'react-icons/md'
import { useTheme } from './ThemeContext'

export type SpeedDialAction = {
  key: string
  label: string
  icon: ReactNode
  onClick?: () => void
  href?: string
}

// The app's shared lower-right FAB: keyboard-shortcuts modal, theme cycler,
// socials. `extraActions` slot in page-specific links (the map's "Browse the
// data", /files' "Back to the map") between the theme toggle and the socials.
// Pass `className="speed-dial-inline"` to render inline (map bottom bar);
// omit it for the default floating LR FAB.
export default function AppSpeedDial({
  extraActions = [],
  className,
}: {
  extraActions?: SpeedDialAction[]
  className?: string
}) {
  const kbdCtx = useHotkeysContext()
  const { themeMode, toggleTheme } = useTheme()
  return (
    <SpeedDial
      className={className}
      showShortcuts={false}
      actions={[
        { key: 'shortcuts', label: 'Keyboard shortcuts', icon: <MdKeyboard />, onClick: () => kbdCtx.openModal() },
        {
          key: 'theme',
          label: `Theme: ${themeMode}`,
          icon: themeMode === 'dark' ? <MdDarkMode /> : themeMode === 'light' ? <MdLightMode /> : <MdSettingsBrightness />,
          onClick: toggleTheme,
        },
        ...extraActions,
        { key: 'bluesky', label: 'Follow on Bluesky', icon: <SiBluesky />, href: 'https://bsky.app/profile/jct.rbw.sh' },
        { key: 'github', label: 'View on GitHub', icon: <FaGithub />, href: 'https://github.com/HackJerseyCity/jc-taxes' },
      ]}
    />
  )
}
