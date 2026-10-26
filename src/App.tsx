import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, History, Menu, X } from 'lucide-react'
import { decodeLocalPath, isLocalResourceUrl, renderMarkdown } from './markdown'
import {
  getDirectoryHandles,
  getDocuments,
  getRecentDocuments,
  getSession,
  putDirectoryHandles,
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
  webkitGetAsEntry?: () => FileSystemEntry | null
}

type HandleWithCapabilities = FileSystemHandle & {
  queryPermission?: (descriptor?: { mode: 'read' }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode: 'read' }) => Promise<PermissionState>
  isSameEntry?: (other: FileSystemHandle) => Promise<boolean>
}

type DirectoryHandleWithEntries = FileSystemDirectoryHandle & HandleWithCapabilities & {
  values?: () => AsyncIterableIterator<FileSystemHandle>
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite'
    startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  }) => Promise<FileSystemDirectoryHandle>
}

type DirectoryInputAttributes = {
  webkitdirectory?: string
  directory?: string
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

let mermaidSeq = 0

const buildMermaidError = (error: unknown, diagram: string): HTMLDivElement => {
  const wrapper = document.createElement('div')
  wrapper.className = 'mermaid-error'

  const heading = document.createElement('strong')
  heading.textContent = 'Mermaid diagram failed to render'

  const message = document.createElement('p')
  message.textContent = error instanceof Error ? error.message : String(error)

  const details = document.createElement('details')
  const summary = document.createElement('summary')
  summary.textContent = 'Show source'
  const pre = document.createElement('pre')
  pre.textContent = diagram
  details.append(summary, pre)

  wrapper.append(heading, message, details)
  return wrapper
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const buildLocalImagePlaceholder = (
  localPath: string,
  prefersDark: boolean,
  hasSavedDirectory: boolean,
): string => {
  const bg = prefersDark ? '#161b22' : '#f6f8fa'
  const border = prefersDark ? '#30363d' : '#d0d7de'
  const titleColor = prefersDark ? '#58a6ff' : '#0969da'
  const pathColor = prefersDark ? '#8b949e' : '#57606a'
  const label = hasSavedDirectory
    ? '点击恢复文件夹权限以显示本地图片'
    : '点击授权所在文件夹以显示本地图片'
  const displayPath = localPath.length > 52 ? `…${localPath.slice(-51)}` : localPath

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="76" viewBox="0 0 460 76">
    <rect x="1" y="1" width="458" height="74" rx="8" fill="${bg}" stroke="${border}" stroke-dasharray="4 3" />
    <g transform="translate(18, 22)" fill="none" stroke="${titleColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="0" y="0" width="28" height="24" rx="4" />
      <circle cx="9" cy="8.5" r="2.5" />
      <path d="M28 17l-7-7L7 24" />
    </g>
    <text x="60" y="33" fill="${titleColor}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="13" font-weight="600">${escapeXml(label)}</text>
    <text x="60" y="53" fill="${pathColor}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5">${escapeXml(displayPath)}</text>
  </svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const darkSchemeQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

function usePrefersDark(): boolean {
  const [prefersDark, setPrefersDark] = useState<boolean>(() => darkSchemeQuery().matches)

  useEffect(() => {
    const query = darkSchemeQuery()
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches)
    query.addEventListener('change', onChange)
    setPrefersDark(query.matches)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return prefersDark
}

const toStoredDocument = (tab: ViewerTab): StoredDocument => {
  const { watching: _watching, ...document } = tab
  return document
}

async function queryHandlePermissionState(handle: FileSystemHandle): Promise<PermissionState> {
  const capable = handle as HandleWithCapabilities
  if (!capable.queryPermission) return 'granted'
  try {
    return await capable.queryPermission({ mode: 'read' })
  } catch {
    return 'denied'
  }
}

async function canReadHandle(handle: FileSystemHandle, requestPermission: boolean): Promise<boolean> {
  const capable = handle as HandleWithCapabilities
  if (!capable.queryPermission) return true

  try {
    const state = await capable.queryPermission({ mode: 'read' })
    if (state === 'granted') return true
    if (!requestPermission || !capable.requestPermission) return false
    return await capable.requestPermission({ mode: 'read' }) === 'granted'
  } catch {
    return false
  }
}

async function isSameHandleEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  if (a.kind !== b.kind) return false
  const capable = a as HandleWithCapabilities
  if (capable.isSameEntry) {
    try {
      return await capable.isSameEntry(b)
    } catch {
      // Fall through to name comparison
    }
  }
  return a.name === b.name
}

async function mergeDirectoryHandles(
  current: FileSystemDirectoryHandle[],
  incoming: FileSystemDirectoryHandle[],
): Promise<FileSystemDirectoryHandle[]> {
  const result: FileSystemDirectoryHandle[] = []
  for (const candidate of [...incoming, ...current]) {
    let exists = false
    for (const item of result) {
      if (await isSameHandleEntry(item, candidate)) {
        exists = true
        break
      }
    }
    if (!exists) result.push(candidate)
  }
  return result.slice(0, 20)
}

function splitLocalPathSegments(rawPath: string): string[] {
  const cleaned = rawPath
    .trim()
    .replace(/^file:\/\/\/?/i, '')
    .replace(/[?#].*$/, '')
    .replaceAll('\\', '/')

  return cleaned
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
}

function resolvePathSegments(baseSegments: string[], relativeSegments: string[]): string[] | null {
  const stack = [...baseSegments]
  for (const segment of relativeSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (stack.length === 0) return null
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.length > 0 ? stack : null
}

async function getDirectoryChild(
  parent: FileSystemDirectoryHandle,
  rawSegment: string,
): Promise<FileSystemDirectoryHandle | null> {
  const decoded = decodeLocalPath(rawSegment)
  const candidates = decoded !== rawSegment ? [decoded, rawSegment] : [rawSegment]
  for (const name of candidates) {
    try {
      return await parent.getDirectoryHandle(name)
    } catch {
      // Try next candidate
    }
  }
  return null
}

async function getFileChild(
  parent: FileSystemDirectoryHandle,
  rawSegment: string,
): Promise<FileSystemFileHandle | null> {
  const decoded = decodeLocalPath(rawSegment)
  const candidates = decoded !== rawSegment ? [decoded, rawSegment] : [rawSegment]
  for (const name of candidates) {
    try {
      return await parent.getFileHandle(name)
    } catch {
      // Try next candidate
    }
  }
  return null
}

async function getFileHandleBySegments(
  rootDir: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemFileHandle | null> {
  if (segments.length === 0) return null
  let currentDir = rootDir
  for (let i = 0; i < segments.length - 1; i += 1) {
    const nextDir = await getDirectoryChild(currentDir, segments[i])
    if (!nextDir) return null
    currentDir = nextDir
  }
  return await getFileChild(currentDir, segments[segments.length - 1])
}

async function findDocumentSubdirectory(
  dirHandle: FileSystemDirectoryHandle,
  docName: string,
  maxDepth = 2,
  prefix: string[] = [],
): Promise<string[] | null> {
  const directMatch = await getFileChild(dirHandle, docName)
  if (directMatch) return prefix

  if (prefix.length >= maxDepth) return null
  const iterable = dirHandle as DirectoryHandleWithEntries
  if (!iterable.values) return null

  try {
    for await (const entry of iterable.values()) {
      if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
        const subResult = await findDocumentSubdirectory(
          entry as FileSystemDirectoryHandle,
          docName,
          maxDepth,
          [...prefix, entry.name],
        )
        if (subResult) return subResult
      }
    }
  } catch {
    return null
  }
  return null
}

async function resolveLocalFileHandleInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  activeTab: ViewerTab | null,
  rawRelativeSegments: string[],
): Promise<FileSystemFileHandle | null> {
  if (rawRelativeSegments.length === 0) return null

  // 1. If the active Markdown file has a handle inside `dirHandle`, `dirHandle.resolve`
  // gives its exact relative location inside `dirHandle`.
  if (activeTab?.handle && typeof dirHandle.resolve === 'function') {
    try {
      const resolvedDocPath = await dirHandle.resolve(activeTab.handle)
      if (resolvedDocPath && resolvedDocPath.length > 0) {
        const baseDir = resolvedDocPath.slice(0, -1)
        const target = resolvePathSegments(baseDir, rawRelativeSegments)
        if (target) {
          const found = await getFileHandleBySegments(dirHandle, target)
          if (found) return found
        }
      }
    } catch {
      // Fall through to additional strategies
    }
  }

  // 2. Try directly from the root of `dirHandle`.
  const rootTarget = resolvePathSegments([], rawRelativeSegments)
  if (rootTarget) {
    const fromRoot = await getFileHandleBySegments(dirHandle, rootTarget)
    if (fromRoot) return fromRoot

    // 3. If the user selected the asset folder itself (e.g. `图片和附件`),
    // strip the leading matching folder name segment.
    const firstDecoded = decodeLocalPath(rootTarget[0])
    if (rootTarget.length > 1 && (firstDecoded === dirHandle.name || rootTarget[0] === dirHandle.name)) {
      const fromAssetRoot = await getFileHandleBySegments(dirHandle, rootTarget.slice(1))
      if (fromAssetRoot) return fromAssetRoot
    }

    // 4. If the path is an absolute path containing `dirHandle.name`, resolve after `dirHandle.name`.
    const dirNameIndex = rootTarget.findIndex(
      (seg) => decodeLocalPath(seg) === dirHandle.name || seg === dirHandle.name,
    )
    if (dirNameIndex >= 0 && dirNameIndex < rootTarget.length - 1) {
      const afterDirName = await getFileHandleBySegments(dirHandle, rootTarget.slice(dirNameIndex + 1))
      if (afterDirName) return afterDirName
    }
  }

  // 5. If `dirHandle` is a parent workspace folder and `activeTab` only has a file name,
  // locate the subdirectory containing `activeTab.name` and resolve relative to it.
  if (activeTab?.name) {
    const docSubdir = await findDocumentSubdirectory(dirHandle, activeTab.name, 2)
    if (docSubdir && docSubdir.length > 0) {
      const target = resolvePathSegments(docSubdir, rawRelativeSegments)
      if (target) {
        const found = await getFileHandleBySegments(dirHandle, target)
        if (found) return found
      }
    }
  }

  return null
}

async function resolveLocalAsset(
  localSrc: string,
  rawSrc: string,
  activeTab: ViewerTab | null,
  directoryHandles: FileSystemDirectoryHandle[],
  memoryFiles: Map<string, File>,
): Promise<{ file: File; handle?: FileSystemFileHandle; directoryHandle?: FileSystemDirectoryHandle } | null> {
  const segments = splitLocalPathSegments(localSrc.length > 0 ? localSrc : rawSrc)
  if (segments.length === 0) return null

  const candidateDirs: FileSystemDirectoryHandle[] = []
  if (activeTab?.directoryHandle) candidateDirs.push(activeTab.directoryHandle)
  for (const dir of directoryHandles) {
    if (!activeTab?.directoryHandle || !(await isSameHandleEntry(activeTab.directoryHandle, dir))) {
      candidateDirs.push(dir)
    }
  }

  for (const dirHandle of candidateDirs) {
    if (!(await canReadHandle(dirHandle, false))) continue
    const fileHandle = await resolveLocalFileHandleInDirectory(dirHandle, activeTab, segments)
    if (fileHandle) {
      try {
        const file = await fileHandle.getFile()
        return { file, handle: fileHandle, directoryHandle: dirHandle }
      } catch {
        // Continue searching
      }
    }
  }

  if (memoryFiles.size > 0) {
    const normalizedTarget = segments.map((seg) => decodeLocalPath(seg)).join('/')
    const direct = memoryFiles.get(normalizedTarget)
    if (direct) return { file: direct }

    const suffix = `/${normalizedTarget}`
    for (const [key, file] of memoryFiles.entries()) {
      if (key === normalizedTarget || key.endsWith(suffix)) {
        return { file }
      }
    }

    const fileNameOnly = decodeLocalPath(segments[segments.length - 1])
    const byName = memoryFiles.get(fileNameOnly)
    if (byName) return { file: byName }
  }

  return null
}

async function collectMarkdownFilesInDirectory(
  dirHandle: FileSystemDirectoryHandle,
  maxDepth = 2,
  currentDepth = 0,
): Promise<FileSystemFileHandle[]> {
  const iterable = dirHandle as DirectoryHandleWithEntries
  if (!iterable.values) return []

  const rootMdFiles: FileSystemFileHandle[] = []
  const nestedDirs: FileSystemDirectoryHandle[] = []

  try {
    for await (const entry of iterable.values()) {
      if (entry.kind === 'file' && /\.(md|markdown)$/i.test(entry.name)) {
        rootMdFiles.push(entry as FileSystemFileHandle)
      } else if (entry.kind === 'directory' && !entry.name.startsWith('.') && currentDepth < maxDepth) {
        nestedDirs.push(entry as FileSystemDirectoryHandle)
      }
    }
  } catch {
    return rootMdFiles
  }

  if (rootMdFiles.length > 0) {
    return rootMdFiles.sort((a, b) => a.name.localeCompare(b.name))
  }

  const nestedResults: FileSystemFileHandle[] = []
  for (const subDir of nestedDirs) {
    const subFiles = await collectMarkdownFilesInDirectory(subDir, maxDepth, currentDepth + 1)
    nestedResults.push(...subFiles)
  }
  return nestedResults.sort((a, b) => a.name.localeCompare(b.name))
}

async function hydrateDocument(document: StoredDocument, requestPermission = false): Promise<ViewerTab> {
  if (!document.handle) return { ...document, watching: false }

  try {
    if (!await canReadHandle(document.handle, requestPermission)) {
      return { ...document, watching: false }
    }

    if (requestPermission && document.directoryHandle) {
      await canReadHandle(document.directoryHandle, true)
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

export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<ViewerTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [recentDocuments, setRecentDocuments] = useState<StoredDocument[]>([])
  const [directoryHandles, setDirectoryHandles] = useState<FileSystemDirectoryHandle[]>([])
  const [memoryFilesVersion, setMemoryFilesVersion] = useState(0)
  const [unresolvedImageCount, setUnresolvedImageCount] = useState(0)
  const [hasSavedDirectoryToPrompt, setHasSavedDirectoryToPrompt] = useState(false)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [activeHeading, setActiveHeading] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const prefersDark = usePrefersDark()

  const contentRef = useRef<HTMLElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const activeOutlineRef = useRef<HTMLAnchorElement>(null)
  const recentMenuRef = useRef<HTMLDivElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<ViewerTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const directoryHandlesRef = useRef<FileSystemDirectoryHandle[]>([])
  const memoryFilesRef = useRef<Map<string, File>>(new Map())
  const scrollByIdRef = useRef<Record<string, number>>({})
  const checkingTabsRef = useRef(new Set<string>())

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  )
  const source = activeTab?.source ?? welcome
  const html = useMemo(() => renderMarkdown(source), [source])
  // React 19 diffs props by reference, so an inline `{ __html }` object would make it
  // reassign innerHTML on every render and destroy anything rendered into the article.
  const markdownHtml = useMemo(() => ({ __html: html }), [html])
  const tabIdsKey = tabs.map((tab) => tab.id).join('|')

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    directoryHandlesRef.current = directoryHandles
  }, [directoryHandles])

  const registerDirectoryHandles = useCallback(async (incoming: FileSystemDirectoryHandle[]): Promise<FileSystemDirectoryHandle[]> => {
    if (incoming.length === 0) return directoryHandlesRef.current
    const merged = await mergeDirectoryHandles(directoryHandlesRef.current, incoming)
    directoryHandlesRef.current = merged
    setDirectoryHandles(merged)
    await putDirectoryHandles(merged)
    return merged
  }, [])

  const persistSession = async (): Promise<void> => {
    await putSession({
      key: 'session',
      openIds: tabsRef.current.map((tab) => tab.id),
      activeId: activeTabIdRef.current,
      scrollById: { ...scrollByIdRef.current },
    })
  }

  const refreshRecents = async (): Promise<void> => {
    setRecentDocuments(await getRecentDocuments(20))
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [session, recents, savedDirs] = await Promise.all([
          getSession(),
          getRecentDocuments(20),
          getDirectoryHandles(),
        ])
        if (cancelled) return

        setRecentDocuments(recents)
        directoryHandlesRef.current = savedDirs
        setDirectoryHandles(savedDirs)
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
    const onScroll = (): void => {
      const id = activeTabIdRef.current
      if (!id) return
      scrollByIdRef.current[id] = window.scrollY
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        void persistSession()
      }, 350)
    }

    const onVisibilityChange = (): void => {
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

  const selectTab = (id: string): void => {
    const current = activeTabIdRef.current
    if (current) scrollByIdRef.current[current] = window.scrollY
    setActiveTabId(id)
  }

  const closeTab = (id: string): void => {
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

  const findMatchingStoredDocument = async (
    handle: FileSystemFileHandle | null,
    file: File,
  ): Promise<StoredDocument | null> => {
    const candidates = await getRecentDocuments(50)

    if (handle) {
      const capable = handle as HandleWithCapabilities
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

  const upsertTab = (tab: ViewerTab, activate = true): void => {
    setTabs((current) => {
      const existingIndex = current.findIndex((item) => item.id === tab.id)
      if (existingIndex < 0) return [...current, tab]
      const next = [...current]
      next[existingIndex] = tab
      return next
    })
    if (activate) selectTab(tab.id)
  }

  const openHandle = async (
    handle: FileSystemFileHandle,
    activate = true,
    directoryHandle?: FileSystemDirectoryHandle,
  ): Promise<string | null> => {
    const file = await handle.getFile()
    if (!/\.(md|markdown)$/i.test(file.name)) return null

    const existing = await findMatchingStoredDocument(handle, file)
    const resolvedDirHandle = directoryHandle ?? existing?.directoryHandle
    const tab: ViewerTab = {
      id: existing?.id ?? crypto.randomUUID(),
      name: file.name,
      source: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
      lastOpenedAt: Date.now(),
      handle,
      directoryHandle: resolvedDirHandle,
      watching: true,
    }

    await putDocument(toStoredDocument(tab))
    upsertTab(tab, activate)
    await refreshRecents()
    return tab.id
  }

  const openFileSnapshot = async (file: File, activate = true): Promise<string | null> => {
    if (!/\.(md|markdown)$/i.test(file.name)) return null

    const existing = await findMatchingStoredDocument(null, file)
    const tab: ViewerTab = {
      id: existing?.id ?? crypto.randomUUID(),
      name: file.name,
      source: await file.text(),
      size: file.size,
      lastModified: file.lastModified,
      lastOpenedAt: Date.now(),
      directoryHandle: existing?.directoryHandle,
      watching: false,
    }

    await putDocument(toStoredDocument(tab))
    upsertTab(tab, activate)
    await refreshRecents()
    return tab.id
  }

  const openRecentDocument = async (document: StoredDocument): Promise<void> => {
    setRecentOpen(false)

    const existingTab = tabsRef.current.find((tab) => tab.id === document.id)
    if (existingTab) {
      if (existingTab.directoryHandle) {
        await canReadHandle(existingTab.directoryHandle, true)
      }
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

  const attachDirectoryToActiveTab = useCallback(async (dirHandle: FileSystemDirectoryHandle): Promise<void> => {
    await registerDirectoryHandles([dirHandle])
    const currentId = activeTabIdRef.current
    if (!currentId) return

    const currentTab = tabsRef.current.find((tab) => tab.id === currentId)
    if (!currentTab) return

    const updated: ViewerTab = {
      ...currentTab,
      directoryHandle: dirHandle,
    }
    setTabs((current) => current.map((item) => item.id === updated.id ? updated : item))
    setRecentDocuments((current) =>
      current.map((item) => item.id === updated.id ? toStoredDocument(updated) : item),
    )
    await putDocument(toStoredDocument(updated))
  }, [registerDirectoryHandles])

  const requestDirectoryAccess = useCallback(async (): Promise<void> => {
    const currentTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null
    const root = contentRef.current
    const sampleImg = root?.querySelector<HTMLImageElement>('img[data-local-src]')
    const sampleLocalSrc = sampleImg?.dataset.localSrc ?? ''
    const sampleRawSrc = sampleImg?.dataset.rawSrc ?? sampleLocalSrc

    // 1. First try re-requesting permission on any already-saved directory handles.
    const candidates: FileSystemDirectoryHandle[] = []
    if (currentTab?.directoryHandle) candidates.push(currentTab.directoryHandle)
    for (const dir of directoryHandlesRef.current) {
      if (!currentTab?.directoryHandle || !(await isSameHandleEntry(currentTab.directoryHandle, dir))) {
        candidates.push(dir)
      }
    }

    let grantedAnySaved = false
    for (const dirHandle of candidates) {
      const state = await queryHandlePermissionState(dirHandle)
      if (state === 'prompt') {
        if (await canReadHandle(dirHandle, true)) {
          grantedAnySaved = true
        }
      }
    }

    if (grantedAnySaved) {
      setDirectoryHandles((prev) => [...prev])
      if (sampleLocalSrc) {
        const resolved = await resolveLocalAsset(
          sampleLocalSrc,
          sampleRawSrc,
          currentTab,
          directoryHandlesRef.current,
          memoryFilesRef.current,
        )
        if (resolved) return
      } else {
        return
      }
    }

    // 2. Otherwise open the native directory picker (or fallback file input).
    const pickerWindow = window as DirectoryPickerWindow
    if (pickerWindow.showDirectoryPicker) {
      try {
        let dirHandle: FileSystemDirectoryHandle
        if (currentTab?.handle) {
          try {
            dirHandle = await pickerWindow.showDirectoryPicker({
              mode: 'read',
              startIn: currentTab.handle,
            })
          } catch (innerError) {
            if (innerError instanceof DOMException && innerError.name === 'AbortError') {
              return
            }
            dirHandle = await pickerWindow.showDirectoryPicker({ mode: 'read' })
          }
        } else {
          dirHandle = await pickerWindow.showDirectoryPicker({ mode: 'read' })
        }
        await attachDirectoryToActiveTab(dirHandle)
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        console.warn('Directory picker failed, falling back to directory input:', error)
      }
    }

    dirInputRef.current?.click()
  }, [attachDirectoryToActiveTab])

  const handleDirectoryInputChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const fileList = event.target.files
    if (!fileList || fileList.length === 0) return

    let openedId: string | null = null
    for (const file of Array.from(fileList)) {
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      const normalized = splitLocalPathSegments(relPath).map((seg) => decodeLocalPath(seg)).join('/')
      if (normalized) {
        memoryFilesRef.current.set(normalized, file)
      }
      memoryFilesRef.current.set(file.name, file)

      if (!activeTabIdRef.current && /\.(md|markdown)$/i.test(file.name)) {
        openedId = await openFileSnapshot(file, false) ?? openedId
      }
    }

    event.target.value = ''
    setMemoryFilesVersion((v) => v + 1)
    if (openedId) selectTab(openedId)
  }

  const handleDrop = async (dataTransfer: DataTransfer): Promise<void> => {
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

    const droppedDirs: FileSystemDirectoryHandle[] = []
    let lastOpenedId: string | null = null
    let addedMemoryFile = false

    for (const entry of pending) {
      const handle = await entry.handlePromise
      if (handle?.kind === 'directory') {
        const dirHandle = handle as FileSystemDirectoryHandle
        droppedDirs.push(dirHandle)
      } else if (handle?.kind === 'file' && /\.(md|markdown)$/i.test(handle.name)) {
        lastOpenedId = await openHandle(handle as FileSystemFileHandle, false) ?? lastOpenedId
      } else if (entry.file && /\.(md|markdown)$/i.test(entry.file.name)) {
        lastOpenedId = await openFileSnapshot(entry.file, false) ?? lastOpenedId
      } else if (entry.file) {
        memoryFilesRef.current.set(entry.file.name, entry.file)
        addedMemoryFile = true
      }
    }

    if (droppedDirs.length > 0) {
      await registerDirectoryHandles(droppedDirs)
      for (const dirHandle of droppedDirs) {
        const mdHandles = await collectMarkdownFilesInDirectory(dirHandle, 2)
        if (mdHandles.length > 0) {
          for (const mdHandle of mdHandles) {
            lastOpenedId = await openHandle(mdHandle, false, dirHandle) ?? lastOpenedId
          }
        } else if (activeTabIdRef.current) {
          await attachDirectoryToActiveTab(dirHandle)
        }
      }
    }

    if (addedMemoryFile) {
      setMemoryFilesVersion((v) => v + 1)
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

    const refreshOpenHandles = async (): Promise<void> => {
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

    const onVisibilityChange = (): void => {
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

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!recentMenuRef.current?.contains(target)) setRecentOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [recentOpen])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const localImages = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-local-src]'))
    if (localImages.length === 0) {
      setUnresolvedImageCount(0)
      setHasSavedDirectoryToPrompt(false)
      return
    }

    let cancelled = false
    const createdUrls: string[] = []

    void (async () => {
      const candidateDirs: FileSystemDirectoryHandle[] = []
      if (activeTab?.directoryHandle) candidateDirs.push(activeTab.directoryHandle)
      for (const dir of directoryHandles) {
        if (!activeTab?.directoryHandle || !(await isSameHandleEntry(activeTab.directoryHandle, dir))) {
          candidateDirs.push(dir)
        }
      }

      let hasPromptable = false
      for (const dirHandle of candidateDirs) {
        if (await queryHandlePermissionState(dirHandle) === 'prompt') {
          hasPromptable = true
          break
        }
      }

      if (cancelled) return
      setHasSavedDirectoryToPrompt(hasPromptable)

      const urlBySrc = new Map<string, string>()
      let unresolved = 0

      for (const img of localImages) {
        if (cancelled) break
        const localSrc = img.dataset.localSrc ?? ''
        const rawSrc = img.dataset.rawSrc ?? localSrc
        if (!localSrc) continue

        const cachedUrl = urlBySrc.get(localSrc)
        if (cachedUrl) {
          img.src = cachedUrl
          img.classList.remove('local-image-pending', 'local-image-unresolved')
          img.classList.add('local-image-resolved')
          continue
        }

        const resolved = await resolveLocalAsset(
          localSrc,
          rawSrc,
          activeTab,
          directoryHandles,
          memoryFilesRef.current,
        )
        if (cancelled) break

        if (resolved) {
          const objectUrl = URL.createObjectURL(resolved.file)
          createdUrls.push(objectUrl)
          urlBySrc.set(localSrc, objectUrl)
          img.src = objectUrl
          img.classList.remove('local-image-pending', 'local-image-unresolved')
          img.classList.add('local-image-resolved')
          img.removeAttribute('title')
        } else {
          unresolved += 1
          img.src = buildLocalImagePlaceholder(localSrc, prefersDark, hasPromptable)
          img.classList.remove('local-image-pending', 'local-image-resolved')
          img.classList.add('local-image-unresolved')
          img.title = hasPromptable
            ? `点击恢复文件夹访问权限以显示: ${localSrc}`
            : `点击授权所在文件夹以显示: ${localSrc}`
        }
      }

      if (!cancelled) {
        setUnresolvedImageCount(unresolved)
      }
    })()

    return () => {
      cancelled = true
      for (const url of createdUrls) {
        URL.revokeObjectURL(url)
      }
    }
  }, [html, activeTab, directoryHandles, memoryFilesVersion, prefersDark])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const collectHeadings = (): HTMLHeadingElement[] =>
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

    const activationLine = (): number => (tabBarRef.current?.offsetHeight ?? 40) + 24

    const updateActiveHeading = (): void => {
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

    const scheduleUpdate = (): void => {
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
    if (!root || !root.querySelector('.mermaid')) return

    let cancelled = false

    void (async () => {
      let mermaid: typeof import('mermaid').default
      try {
        mermaid = (await import('mermaid')).default
      } catch (error) {
        console.error('Unable to load Mermaid:', error)
        if (cancelled) return
        for (const node of Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))) {
          node.classList.add('mermaid-failed')
          node.replaceChildren(buildMermaidError(error, node.dataset.mermaidSource ?? ''))
        }
        return
      }
      if (cancelled) return

      const theme = prefersDark ? 'dark' : 'default'
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme,
        fontFamily: 'inherit',
      })

      // Re-query here: the article's innerHTML may have been rewritten while we awaited.
      for (const node of Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))) {
        if (cancelled) return
        if (!node.isConnected || node.dataset.mermaidTheme === theme) continue

        const diagram = node.dataset.mermaidSource ?? ''
        if (!diagram.trim()) continue

        mermaidSeq += 1
        const id = `mermaid-svg-${mermaidSeq}`
        try {
          const { svg, bindFunctions } = await mermaid.render(id, diagram)
          if (cancelled || !node.isConnected) return
          node.innerHTML = svg
          bindFunctions?.(node)
          node.classList.remove('mermaid-failed')
          node.dataset.mermaidTheme = theme
        } catch (error) {
          if (cancelled || !node.isConnected) return
          // Mermaid can leave its scratch elements behind when parsing throws.
          document.getElementById(id)?.remove()
          document.getElementById(`d${id}`)?.remove()
          node.classList.add('mermaid-failed')
          node.dataset.mermaidTheme = theme
          node.replaceChildren(buildMermaidError(error, diagram))
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [html, prefersDark])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const onClick = async (event: MouseEvent): Promise<void> => {
      const target = event.target as HTMLElement

      const unresolvedImg = target.closest<HTMLImageElement>('img.local-image-unresolved')
      if (unresolvedImg) {
        event.preventDefault()
        await requestDirectoryAccess()
        return
      }

      const link = target.closest<HTMLAnchorElement>('a[href]')
      if (link) {
        const rawHref = link.getAttribute('href') ?? ''
        if (isLocalResourceUrl(rawHref)) {
          event.preventDefault()
          const currentTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current) ?? null
          const decodedHref = decodeLocalPath(rawHref)
          const resolved = await resolveLocalAsset(
            decodedHref,
            rawHref,
            currentTab,
            directoryHandlesRef.current,
            memoryFilesRef.current,
          )
          if (!resolved) {
            await requestDirectoryAccess()
            return
          }
          if (/\.(md|markdown)$/i.test(resolved.file.name)) {
            if (resolved.handle) {
              await openHandle(resolved.handle, true, resolved.directoryHandle)
            } else {
              await openFileSnapshot(resolved.file, true)
            }
          } else {
            const blobUrl = URL.createObjectURL(resolved.file)
            window.open(blobUrl, '_blank', 'noopener,noreferrer')
            window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
          }
          return
        }
      }

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
  }, [html, requestDirectoryAccess])

  const directoryInputProps: DirectoryInputAttributes = {
    webkitdirectory: '',
    directory: '',
  }

  return (
    <div
      className="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        void handleDrop(event.dataTransfer)
      }}
    >
      <input
        ref={dirInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => void handleDirectoryInputChange(event)}
        {...directoryInputProps}
      />

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
        {unresolvedImageCount > 0 && (
          <div className="local-assets-banner" role="status">
            <div className="local-assets-banner-info">
              <FolderOpen size={16} className="local-assets-banner-icon" />
              <span>
                检测到 <strong>{unresolvedImageCount}</strong> 张本地图片未加载。受浏览器安全限制，请授权文档所在文件夹（或直接将文件夹拖入窗口）。
              </span>
            </div>
            <button
              type="button"
              className="local-assets-button"
              onClick={() => void requestDirectoryAccess()}
            >
              {hasSavedDirectoryToPrompt ? '恢复文件夹权限' : '授权所在文件夹'}
            </button>
          </div>
        )}
        <article ref={contentRef} className="markdown-body" dangerouslySetInnerHTML={markdownHtml} />
      </main>
    </div>
  )
}
