import { useEffect, useMemo, useRef, useState } from 'react'
import { History, Menu, X } from 'lucide-react'
import { renderMarkdown } from './markdown'
import {
  getDocuments,
  getRecentDocuments,
  getSession,
  putDocument,
  putSession,
  type StoredDocument,
} from './storage'

type OutlineItem = {
  id: string
  text: string
  level: number
}

type ViewerTab = StoredDocument & {
  watching: boolean
}

type LaunchParamsLike = {
  files: FileSystemFileHandle[]
}

type LaunchQueueLike = {
  setConsumer: (consumer: (params: LaunchParamsLike) => void | Promise<void>) => void
}

type DataTransferItemWithHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

type FileHandleWithCapabilities = FileSystemFileHandle & {
  queryPermission?: (descriptor?: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode: 'read' }) => Promise<PermissionState>
  isSameEntry?: (other: FileSystemHandle) => Promise<boolean>
}

const welcome = `# Markdown PWA Viewer

Drag one or more local \`.md\` files into this window, or install this app and associate Markdown files with it.

## Features

- Multiple tabs
- Recent files restored from IndexedDB
- GitHub-flavored Markdown basics
- $\\KaTeX$ formulas
- Mermaid diagrams
- Syntax highlighting
- One-click code copy
- Automatic outline navigation
- Live reload for handle-backed local files

## Formula

$$
E = mc^2
$$

## Mermaid

\`\`\`mermaid
flowchart LR
  Markdown --> Parse
  Parse --> Preview
\`\`\`

## Code

\`\`\`ts
const hello = 'Markdown'
console.log(hello)
\`\`\`
`

const toStoredDocument = (tab: ViewerTab): StoredDocument => {
  const { watching: _watching, ...document } = tab
  return document
}

async function canReadHandle(handle: FileSystemFileHandle, requestPermission: boolean) {
  const capable = handle as FileHandleWithCapabilities
  if (!capable.queryPermission) return true

  const state = await capable.queryPermission({ mode: 'read' })
  if (state === 'granted') return true
  if (!requestPermission || !capable.requestPermission) return false
  return await capable.requestPermission({ mode: 'read' }) === 'granted'
}

async function hydrateDocument(document: StoredDocument, requestPermission = false): Promise<ViewerTab> {
  if (!document.handle) return { ...document, watching: false }

  try {
    if (!await canReadHandle(document.handle, requestPermission)) {
      return { ...document, watching: false }
    }

    const file = await document.handle.getFile()
    return {
      ...document,
      name: file.name,
      source: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
      watching: true,
    }
  } catch (error) {
    console.warn(`Unable to restore ${document.name} from its file handle:`, error)
    return { ...document, watching: false }
  }
}

export default function App() {
  const [tabs, setTabs] = useState<ViewerTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [recentDocuments, setRecentDocuments] = useState<StoredDocument[]>([])
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [activeHeading, setActiveHeading] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  const contentRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const activeOutlineRef = useRef<HTMLAnchorElement>(null)
  const recentMenuRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<ViewerTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const scrollByIdRef = useRef<Record<string, number>>({})
  const checkingTabsRef = useRef(new Set<string>())

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  )
  const source = activeTab?.source ?? welcome
  const html = useMemo(() => renderMarkdown(source), [source])
  const tabIdsKey = tabs.map((tab) => tab.id).join('|')

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  const persistSession = async () => {
    await putSession({
      key: 'session',
      openIds: tabsRef.current.map((tab) => tab.id),
      activeId: activeTabIdRef.current,
      scrollById: { ...scrollByIdRef.current },
    })
  }

  const refreshRecents = async () => {
    setRecentDocuments(await getRecentDocuments(20))
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [session, recents] = await Promise.all([
          getSession(),
          getRecentDocuments(20),
        ])
        if (cancelled) return

        setRecentDocuments(recents)
        scrollByIdRef.current = session?.scrollById ?? {}

        if (session?.openIds.length) {
          const stored = await getDocuments(session.openIds)
          const byId = new Map(stored.map((document) => [document.id, document]))
          const ordered = session.openIds
            .map((id) => byId.get(id))
            .filter((document): document is StoredDocument => Boolean(document))
          const restored = await Promise.all(ordered.map((document) => hydrateDocument(document)))
          if (cancelled) return

          setTabs(restored)
          const restoredActive = session.activeId && restored.some((tab) => tab.id === session.activeId)
            ? session.activeId
            : restored[0]?.id ?? null
          setActiveTabId(restoredActive)

          for (const tab of restored) {
            if (tab.watching) void putDocument(toStoredDocument(tab))
          }
        }
      } catch (error) {
        console.warn('Unable to restore the previous Markdown session:', error)
      } finally {
        if (!cancelled) setHydrated(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const timeoutId = window.setTimeout(() => {
      void persistSession()
    }, 80)
    return () => window.clearTimeout(timeoutId)
  }, [hydrated, tabIdsKey, activeTabId])

  useEffect(() => {
    if (!hydrated) return

    let saveTimer = 0
    const onScroll = () => {
      const id = activeTabIdRef.current
      if (!id) return
      scrollByIdRef.current[id] = window.scrollY
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        void persistSession()
      }, 350)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void persistSession()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearTimeout(saveTimer)
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [hydrated])

  useEffect(() => {
    document.title = activeTab ? `${activeTab.name} · Markdown Viewer` : 'Markdown PWA Viewer'
  }, [activeTab?.id, activeTab?.name])

  useEffect(() => {
    if (!activeTabId) return
    const targetY = scrollByIdRef.current[activeTabId] ?? 0
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: targetY, left: 0, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTabId])

  const selectTab = (id: string) => {
    const current = activeTabIdRef.current
    if (current) scrollByIdRef.current[current] = window.scrollY
    setActiveTabId(id)
  }

  const closeTab = (id: string) => {
    const currentTabs = tabsRef.current
    const index = currentTabs.findIndex((tab) => tab.id === id)
    if (index < 0) return

    if (activeTabIdRef.current) {
      scrollByIdRef.current[activeTabIdRef.current] = window.scrollY
    }

    const remaining = currentTabs.filter((tab) => tab.id !== id)
    delete scrollByIdRef.current[id]
    setTabs(remaining)

    if (activeTabIdRef.current === id) {
      const replacement = remaining[Math.min(index, remaining.length - 1)]?.id ?? null
      setActiveTabId(replacement)
    }
  }

  const findMatchingStoredDocument = async (handle: FileSystemFileHandle | null, file: File) => {
    const candidates = await getRecentDocuments(50)

    if (handle) {
      const capable = handle as FileHandleWithCapabilities
      if (capable.isSameEntry) {
        for (const candidate of candidates) {
          if (!candidate.handle) continue
          try {
            if (await capable.isSameEntry(candidate.handle)) return candidate
          } catch {
            // Fall through to metadata matching.
          }
        }
      }
    }

    return candidates.find((candidate) =>
      candidate.name === file.name
      && candidate.size === file.size
      && candidate.lastModified === file.lastModified,
    ) ?? null
  }

  const upsertTab = (tab: ViewerTab, activate = true) => {
    setTabs((current) => {
      const existingIndex = current.findIndex((item) => item.id === tab.id)
      if (existingIndex < 0) return [...current, tab]
      const next = [...current]
      next[existingIndex] = tab
      return next
    })
    if (activate) selectTab(tab.id)
  }

  const openHandle = async (handle: FileSystemFileHandle, activate = true) => {
    const file = await handle.getFile()
    if (!/\.(md|markdown)$/i.test(file.name)) return null

    const existing = await findMatchingStoredDocument(handle, file)
    const tab: ViewerTab = {
      id: existing?.id ?? crypto.randomUUID(),
      name: file.name,
      source: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
      lastOpenedAt: Date.now(),
      handle,
      watching: true,
    }

    await putDocument(toStoredDocument(tab))
    upsertTab(tab, activate)
    await refreshRecents()
    return tab.id
  }

  const openFileSnapshot = async (file: File, activate = true) => {
    if (!/\.(md|markdown)$/i.test(file.name)) return null

    const existing = await findMatchingStoredDocument(null, file)
    const tab: ViewerTab = {
      id: existing?.id ?? crypto.randomUUID(),
      name: file.name,
      source: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
      lastOpenedAt: Date.now(),
      watching: false,
    }

    await putDocument(toStoredDocument(tab))
    upsertTab(tab, activate)
    await refreshRecents()
    return tab.id
  }

  const openRecentDocument = async (document: StoredDocument) => {
    setRecentOpen(false)

    const existingTab = tabsRef.current.find((tab) => tab.id === document.id)
    if (existingTab) {
      const touched = { ...existingTab, lastOpenedAt: Date.now() }
      upsertTab(touched)
      await putDocument(toStoredDocument(touched))
      await refreshRecents()
      return
    }

    const restored = await hydrateDocument({ ...document, lastOpenedAt: Date.now() }, true)
    await putDocument(toStoredDocument(restored))
    upsertTab(restored)
    await refreshRecents()
  }

  const handleDrop = async (dataTransfer: DataTransfer) => {
    const pending = Array.from(dataTransfer.items)
      .filter((item) => item.kind === 'file')
      .map((rawItem) => {
        const item = rawItem as DataTransferItemWithHandle
        return {
          file: rawItem.getAsFile(),
          handlePromise: item.getAsFileSystemHandle
            ? item.getAsFileSystemHandle().catch(() => null)
            : Promise.resolve(null),
        }
      })

    let lastOpenedId: string | null = null
    for (const entry of pending) {
      const handle = await entry.handlePromise
      if (handle?.kind === 'file' && /\.(md|markdown)$/i.test(handle.name)) {
        lastOpenedId = await openHandle(handle as FileSystemFileHandle, false) ?? lastOpenedId
      } else if (entry.file && /\.(md|markdown)$/i.test(entry.file.name)) {
        lastOpenedId = await openFileSnapshot(entry.file, false) ?? lastOpenedId
      }
    }

    if (lastOpenedId) selectTab(lastOpenedId)
  }

  useEffect(() => {
    if (!hydrated) return
    const launchQueue = (window as Window & { launchQueue?: LaunchQueueLike }).launchQueue
    launchQueue?.setConsumer(async ({ files }) => {
      let lastOpenedId: string | null = null
      for (const handle of files) {
        lastOpenedId = await openHandle(handle, false) ?? lastOpenedId
      }
      if (lastOpenedId) selectTab(lastOpenedId)
    })
  }, [hydrated])

  useEffect(() => {
    let cancelled = false

    const refreshOpenHandles = async () => {
      for (const tab of tabsRef.current) {
        if (cancelled || !tab.handle || !tab.watching || checkingTabsRef.current.has(tab.id)) continue

        checkingTabsRef.current.add(tab.id)
        try {
          const file = await tab.handle.getFile()
          if (file.lastModified === tab.lastModified && file.size === tab.size) continue

          const updated: ViewerTab = {
            ...tab,
            name: file.name,
            source: await file.text(),
            size: file.size,
            lastModified: file.lastModified,
          }
          setTabs((current) => current.map((item) => item.id === updated.id ? updated : item))
          setRecentDocuments((current) => current.map((item) => item.id === updated.id ? toStoredDocument(updated) : item))
          void putDocument(toStoredDocument(updated))
        } catch (error) {
          console.warn(`Unable to live-reload ${tab.name}:`, error)
          setTabs((current) => current.map((item) => item.id === tab.id ? { ...item, watching: false } : item))
        } finally {
          checkingTabsRef.current.delete(tab.id)
        }
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshOpenHandles()
    }, 1000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshOpenHandles()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!recentOpen) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!recentMenuRef.current?.contains(target)) setRecentOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [recentOpen])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const collectHeadings = () =>
      Array.from(root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6'))

    const headings = collectHeadings()
    setOutline(headings.map((heading) => ({
      id: heading.id,
      text: heading.textContent?.replace(/^#\s*/, '') || 'Untitled',
      level: Number(heading.tagName.slice(1)),
    })))

    if (!headings.length) {
      setActiveHeading('')
      return
    }

    let scrollFrame = 0

    const activationLine = () => (tabBarRef.current?.offsetHeight ?? 40) + 24

    const updateActiveHeading = () => {
      scrollFrame = 0
      const liveHeadings = collectHeadings()
      if (!liveHeadings.length) return

      const firstRect = liveHeadings[0].getBoundingClientRect()
      if (firstRect.width === 0 && firstRect.height === 0) return

      const scrollRoot = document.scrollingElement ?? document.documentElement
      const canScroll = scrollRoot.scrollHeight > scrollRoot.clientHeight + 1
      const atBottom = canScroll
        && scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 2

      if (atBottom) {
        const lastId = liveHeadings[liveHeadings.length - 1].id
        setActiveHeading((current) => current === lastId ? current : lastId)
        return
      }

      const line = activationLine()
      let nextId = liveHeadings[0].id
      for (const heading of liveHeadings) {
        if (heading.getBoundingClientRect().top <= line) {
          nextId = heading.id
        } else {
          break
        }
      }

      setActiveHeading((current) => current === nextId ? current : nextId)
    }

    const scheduleUpdate = () => {
      if (scrollFrame) return
      scrollFrame = window.requestAnimationFrame(updateActiveHeading)
    }

    updateActiveHeading()
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(root)
    if (tabBarRef.current) resizeObserver.observe(tabBarRef.current)

    return () => {
      resizeObserver.disconnect()
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame)
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [html, activeTabId])

  useEffect(() => {
    const sidebar = sidebarRef.current
    const item = activeOutlineRef.current
    if (!sidebar || !item) return

    const header = sidebar.querySelector<HTMLElement>('.sidebar-header')
    const sidebarRect = sidebar.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    const topBoundary = sidebarRect.top + (header?.offsetHeight ?? 0) + 8
    const bottomBoundary = sidebarRect.bottom - 8

    if (itemRect.top < topBoundary) {
      sidebar.scrollTop -= topBoundary - itemRect.top
    } else if (itemRect.bottom > bottomBoundary) {
      sidebar.scrollTop += itemRect.bottom - bottomBoundary
    }
  }, [activeHeading])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))
    if (!diagrams.length) return

    let cancelled = false
    void import('mermaid')
      .then(({ default: mermaid }) => {
        if (cancelled) return
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          fontFamily: 'inherit',
        })
        return mermaid.run({ nodes: diagrams })
      })
      .catch((error) => {
        console.error('Mermaid render failed:', error)
      })

    return () => {
      cancelled = true
    }
  }, [html])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const onClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement
      const button = target.closest<HTMLButtonElement>('.copy-code')
      if (!button) return
      const code = button.closest('.code-block')?.querySelector('code')?.textContent || ''
      await navigator.clipboard.writeText(code)
      const original = button.textContent
      button.textContent = 'Copied'
      window.setTimeout(() => { button.textContent = original }, 1200)
    }

    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [html])

  return (
    <div
      className="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        void handleDrop(event.dataTransfer)
      }}
    >
      <button className="outline-toggle mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open outline">
        <Menu size={20} />
      </button>

      <aside ref={sidebarRef} className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <strong>Outline</strong>
          <div className="sidebar-actions">
            {activeTab?.watching && <span className="watch-status" title="Watching for external file changes"><span className="watch-dot" />Live</span>}
            <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close outline"><X size={19} /></button>
          </div>
        </div>
        <nav>
          {outline.length ? outline.map((item) => {
            const isActive = activeHeading === item.id
            return (
              <a
                key={item.id}
                ref={isActive ? activeOutlineRef : undefined}
                href={`#${item.id}`}
                className={`outline-item${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'location' : undefined}
                style={{ paddingLeft: `${12 + (item.level - 1) * 14}px` }}
                onClick={() => {
                  setActiveHeading(item.id)
                  setSidebarOpen(false)
                }}
              >
                {item.text}
              </a>
            )
          }) : <span className="outline-empty">No headings</span>}
        </nav>
      </aside>

      <div ref={tabBarRef} className="tabbar">
        <div ref={recentMenuRef} className="recent-nav">
          <button
            className={`recent-toggle${recentOpen ? ' active' : ''}`}
            onClick={() => setRecentOpen((open) => !open)}
            aria-expanded={recentOpen}
            aria-label="Recent files"
            title="Recent files"
          >
            <History size={16} />
            <span>Recent</span>
          </button>

          {recentOpen && (
            <div className="recent-menu">
              <div className="recent-menu-title">Recent files</div>
              {recentDocuments.length ? recentDocuments.map((document) => (
                <button key={document.id} className="recent-menu-item" onClick={() => void openRecentDocument(document)}>
                  <span className="recent-file-name">{document.name}</span>
                  <span className="recent-file-time">{new Date(document.lastOpenedAt).toLocaleString()}</span>
                </button>
              )) : <div className="recent-empty">No recent files</div>}
            </div>
          )}
        </div>

        <div className="tabs-strip" role="tablist" aria-label="Open Markdown files">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={isActive}
                className={`tab-item${isActive ? ' active' : ''}`}
                title={tab.name}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') selectTab(tab.id)
                }}
              >
                <span className="tab-name">{tab.name}</span>
                <button
                  className="tab-close"
                  aria-label={`Close ${tab.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>
      </div>

      {sidebarOpen && <button className="backdrop mobile-only" aria-label="Close outline" onClick={() => setSidebarOpen(false)} />}

      <main className="viewer">
        <article ref={contentRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  )
}
