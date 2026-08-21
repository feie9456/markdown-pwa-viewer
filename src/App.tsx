import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderOpen, Menu, X } from 'lucide-react'
import { renderMarkdown } from './markdown'

type OutlineItem = {
  id: string
  text: string
  level: number
}

type FileSnapshot = {
  lastModified: number
  size: number
}

type LaunchParamsLike = {
  files: FileSystemFileHandle[]
}

type LaunchQueueLike = {
  setConsumer: (consumer: (params: LaunchParamsLike) => void | Promise<void>) => void
}

const welcome = `# Markdown PWA Viewer

Open a local \`.md\` file, drag one into this window, or install this app and associate Markdown files with it.

## Features

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

async function readHandle(handle: FileSystemFileHandle) {
  const file = await handle.getFile()
  return {
    name: file.name,
    text: await file.text(),
    lastModified: file.lastModified,
    size: file.size,
  }
}

export default function App() {
  const [source, setSource] = useState(welcome)
  const [fileName, setFileName] = useState('Welcome.md')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [activeHeading, setActiveHeading] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [watching, setWatching] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const activeOutlineRef = useRef<HTMLAnchorElement>(null)
  const activeHandleRef = useRef<FileSystemFileHandle | null>(null)
  const fileSnapshotRef = useRef<FileSnapshot | null>(null)
  const html = useMemo(() => renderMarkdown(source), [source])

  const applyLoadedFile = (name: string, text: string) => {
    setSource(text)
    setFileName(name)
    document.title = `${name} · Markdown Viewer`
  }

  const loadFile = async (file: File) => {
    activeHandleRef.current = null
    fileSnapshotRef.current = null
    setWatching(false)
    applyLoadedFile(file.name, await file.text())
  }

  const loadHandle = async (handle: FileSystemFileHandle) => {
    const loaded = await readHandle(handle)
    activeHandleRef.current = handle
    fileSnapshotRef.current = {
      lastModified: loaded.lastModified,
      size: loaded.size,
    }
    setWatching(true)
    applyLoadedFile(loaded.name, loaded.text)
  }

  useEffect(() => {
    const launchQueue = (window as Window & { launchQueue?: LaunchQueueLike }).launchQueue
    launchQueue?.setConsumer(async ({ files }) => {
      const handle = files[0]
      if (handle) await loadHandle(handle)
    })
  }, [])

  useEffect(() => {
    let checking = false

    const refreshIfChanged = async () => {
      const handle = activeHandleRef.current
      if (!handle || checking) return

      checking = true
      try {
        const file = await handle.getFile()
        const previous = fileSnapshotRef.current
        const changed = !previous
          || file.lastModified !== previous.lastModified
          || file.size !== previous.size

        if (!changed) return

        const text = await file.text()
        fileSnapshotRef.current = {
          lastModified: file.lastModified,
          size: file.size,
        }
        setSource((current) => current === text ? current : text)
        setFileName(file.name)
        document.title = `${file.name} · Markdown Viewer`
      } catch (error) {
        console.warn('Unable to check Markdown file for changes:', error)
      } finally {
        checking = false
      }
    }

    const intervalId = window.setInterval(() => {
      void refreshIfChanged()
    }, 1000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshIfChanged()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const headings = Array.from(root.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4, h5, h6'))
    setOutline(headings.map((heading) => ({
      id: heading.id,
      text: heading.textContent?.replace(/^#\s*/, '') || 'Untitled',
      level: Number(heading.tagName.slice(1)),
    })))

    if (!headings.length) {
      setActiveHeading('')
      return
    }

    let frame = 0
    const updateActiveHeading = () => {
      frame = 0
      const activationLine = 84
      let nextActive = headings[0].id

      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= activationLine) {
          nextActive = heading.id
        } else {
          break
        }
      }

      setActiveHeading((current) => current === nextActive ? current : nextActive)
    }

    const scheduleUpdate = () => {
      if (frame) return
      frame = window.requestAnimationFrame(updateActiveHeading)
    }

    updateActiveHeading()
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [html])

  useEffect(() => {
    activeOutlineRef.current?.scrollIntoView({ block: 'nearest' })
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

  const openFile = async () => {
    const picker = (window as Window & {
      showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>
    }).showOpenFilePicker

    if (picker) {
      const [handle] = await picker({
        multiple: false,
        types: [{
          description: 'Markdown files',
          accept: { 'text/markdown': ['.md', '.markdown'] },
        }],
      })
      if (handle) await loadHandle(handle)
      return
    }

    document.getElementById('file-input')?.click()
  }

  return (
    <div
      className="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file && /\.(md|markdown)$/i.test(file.name)) void loadFile(file)
      }}
    >
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)} aria-label="Open outline">
          <Menu size={20} />
        </button>
        <div className="file-title">
          <FileText size={18} />
          <span className="file-name">{fileName}</span>
          {watching && <span className="watch-status" title="Watching for external file changes"><span className="watch-dot" />Live</span>}
        </div>
        <button className="open-button" onClick={() => void openFile()}><FolderOpen size={17} /> Open</button>
        <input
          id="file-input"
          hidden
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.currentTarget.value = ''
          }}
        />
      </header>

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <strong>Outline</strong>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close outline"><X size={19} /></button>
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

      {sidebarOpen && <button className="backdrop mobile-only" aria-label="Close outline" onClick={() => setSidebarOpen(false)} />}

      <main className="viewer">
        <article ref={contentRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  )
}
