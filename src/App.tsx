import { useEffect, useMemo, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { FileText, FolderOpen, Menu, X } from 'lucide-react'
import { renderMarkdown } from './markdown'

type OutlineItem = {
  id: string
  text: string
  level: number
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

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
  fontFamily: 'inherit',
})

async function readHandle(handle: FileSystemFileHandle) {
  const file = await handle.getFile()
  return { name: file.name, text: await file.text() }
}

export default function App() {
  const [source, setSource] = useState(welcome)
  const [fileName, setFileName] = useState('Welcome.md')
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const contentRef = useRef<HTMLElement>(null)
  const html = useMemo(() => renderMarkdown(source), [source])

  const loadFile = async (file: File) => {
    setSource(await file.text())
    setFileName(file.name)
    document.title = `${file.name} · Markdown Viewer`
  }

  useEffect(() => {
    const launchQueue = (window as Window & { launchQueue?: LaunchQueueLike }).launchQueue
    launchQueue?.setConsumer(async ({ files }) => {
      const handle = files[0]
      if (!handle) return
      const loaded = await readHandle(handle)
      setSource(loaded.text)
      setFileName(loaded.name)
      document.title = `${loaded.name} · Markdown Viewer`
    })
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

    const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))
    if (diagrams.length) {
      mermaid.run({ nodes: diagrams }).catch((error) => {
        console.error('Mermaid render failed:', error)
      })
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
      if (handle) {
        const loaded = await readHandle(handle)
        setSource(loaded.text)
        setFileName(loaded.name)
        document.title = `${loaded.name} · Markdown Viewer`
      }
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
        <div className="file-title"><FileText size={18} /><span>{fileName}</span></div>
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
          {outline.length ? outline.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="outline-item"
              style={{ paddingLeft: `${12 + (item.level - 1) * 14}px` }}
              onClick={() => setSidebarOpen(false)}
            >
              {item.text}
            </a>
          )) : <span className="outline-empty">No headings</span>}
        </nav>
      </aside>

      {sidebarOpen && <button className="backdrop mobile-only" aria-label="Close outline" onClick={() => setSidebarOpen(false)} />}

      <main className="viewer">
        <article ref={contentRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  )
}
