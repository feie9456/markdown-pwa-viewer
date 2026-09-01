import MarkdownIt from 'markdown-it'
import type { StateBlock } from 'markdown-it'
import anchor from 'markdown-it-anchor'
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import hljs from 'highlight.js'
import { load as loadYaml } from 'js-yaml'

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const highlight = (code: string, language: string) => {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  }
  return hljs.highlightAuto(code).value
}

/* ---------------------------------------------------------------- front matter */

const FRONT_MATTER_MAX_DEPTH = 4

type YamlValue = unknown

const isScalar = (value: YamlValue): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const isPlainObject = (value: YamlValue): value is Record<string, YamlValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)

const renderScalar = (value: string | number | boolean | null) => {
  if (value === null) return '<span class="fm-empty">null</span>'
  if (typeof value === 'boolean') return `<span class="fm-token fm-bool">${value}</span>`
  if (typeof value === 'number') return `<span class="fm-token fm-number">${value}</span>`
  if (!value) return '<span class="fm-empty">empty</span>'
  return value.includes('\n')
    ? `<pre class="fm-multiline">${escapeHtml(value)}</pre>`
    : escapeHtml(value)
}

// A list of uniform records reads far better as one table than as N nested tables.
const sharedScalarKeys = (items: YamlValue[]) => {
  if (items.length < 2 || !items.every(isPlainObject)) return null

  const keys = Object.keys(items[0] as Record<string, YamlValue>)
  if (!keys.length || keys.length > 8) return null

  const matches = (items as Record<string, YamlValue>[]).every((item) => {
    const itemKeys = Object.keys(item)
    return itemKeys.length === keys.length
      && itemKeys.every((key) => keys.includes(key))
      && keys.every((key) => isScalar(item[key]))
  })

  return matches ? keys : null
}

const renderValue = (value: YamlValue, depth: number): string => {
  if (isScalar(value)) return renderScalar(value)
  if (value instanceof Date) return escapeHtml(value.toISOString())
  if (depth >= FRONT_MATTER_MAX_DEPTH) return `<code>${escapeHtml(JSON.stringify(value))}</code>`

  if (Array.isArray(value)) {
    if (!value.length) return '<span class="fm-empty">empty</span>'

    const columns = sharedScalarKeys(value)
    if (columns) {
      const head = columns.map((key) => `<th>${escapeHtml(key)}</th>`).join('')
      const body = (value as Record<string, YamlValue>[])
        .map((item) => `<tr>${columns.map((key) => `<td>${renderValue(item[key], depth + 1)}</td>`).join('')}</tr>`)
        .join('')
      return `<table class="fm-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    }

    const items = value.map((item) => `<li>${renderValue(item, depth + 1)}</li>`).join('')
    return `<ul class="fm-list">${items}</ul>`
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    if (!entries.length) return '<span class="fm-empty">empty</span>'
    const rows = entries
      .map(([key, item]) => `<tr><th>${escapeHtml(key)}</th><td>${renderValue(item, depth + 1)}</td></tr>`)
      .join('')
    return `<table class="fm-grid"><tbody>${rows}</tbody></table>`
  }

  return `<code>${escapeHtml(String(value))}</code>`
}

const renderRawFrontMatter = (raw: string, reason?: string) => `<details class="front-matter" open>
  <summary><span class="fm-label">Front matter</span>${reason ? `<span class="fm-note">${escapeHtml(reason)}</span>` : ''}</summary>
  <div class="fm-body"><pre class="fm-raw"><code class="hljs language-yaml">${highlight(raw, 'yaml')}</code></pre></div>
</details>`

const renderFrontMatter = (raw: string) => {
  if (!raw.trim()) return ''

  let data: YamlValue
  try {
    data = loadYaml(raw)
  } catch (error) {
    return renderRawFrontMatter(raw, error instanceof Error ? error.message : 'invalid YAML')
  }

  if (!isPlainObject(data)) return renderRawFrontMatter(raw)

  const entries = Object.entries(data)
  if (!entries.length) return ''

  const title = typeof data.name === 'string' && data.name
    ? data.name
    : typeof data.title === 'string' && data.title
      ? data.title
      : ''

  const rows = entries
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${renderValue(value, 1)}</td></tr>`)
    .join('')

  return `<details class="front-matter" open>
  <summary><span class="fm-label">Front matter</span>${title ? `<span class="fm-title">${escapeHtml(title)}</span>` : ''}</summary>
  <div class="fm-body"><table class="fm-grid fm-root"><tbody>${rows}</tbody></table></div>
</details>`
}

const frontMatterRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => {
  // Front matter is only front matter at the very top of the document.
  if (startLine !== 0 || state.blkIndent !== 0 || state.tShift[startLine] !== 0) return false

  const openLine = state.src.slice(state.bMarks[startLine], state.eMarks[startLine])
  if (openLine.trimEnd() !== '---') return false

  let closeLine = -1
  for (let line = startLine + 1; line < endLine; line += 1) {
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trimEnd()
    if (text === '---' || text === '...') {
      closeLine = line
      break
    }
  }
  if (closeLine < 0) return false

  const content = state.getLines(startLine + 1, closeLine, 0, false)
  // Without this, a document that merely opens with a `---` horizontal rule would be
  // swallowed up to the next one. Real front matter starts with a top-level YAML key.
  const firstKey = content
    .split('\n')
    .find((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (!firstKey || !/^\S.*?:(\s|$)/.test(firstKey)) return false

  if (silent) return true

  const token = state.push('front_matter', '', 0)
  token.markup = '---'
  token.content = content
  token.map = [startLine, closeLine + 1]
  token.block = true

  state.line = closeLine + 1
  return true
}

/* ---------------------------------------------------------------- markdown-it */

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

md.block.ruler.before('table', 'front_matter', frontMatterRule, { alt: [] })
md.renderer.rules.front_matter = (tokens, idx) => renderFrontMatter(tokens[idx].content)

md.use(anchor, {
  permalink: anchor.permalink.linkInsideHeader({
    symbol: '#',
    placement: 'before',
    class: 'heading-anchor',
    ariaHidden: true,
  }),
})

md.use(texmath, {
  engine: katex,
  delimiters: 'dollars',
  katexOptions: {
    throwOnError: false,
    strict: false,
  },
})

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = token.info.trim()

  let language = info.split(/\s+/)[0] ?? ''
  let label = language

  if (language === 'mermaid') {
    // The source lives in a data attribute so re-renders never read back the rendered SVG.
    return `<div class="mermaid" data-mermaid-source="${escapeHtml(token.content)}"></div>`
  }

  // Cursor-style code citations use `startLine:endLine:path` as the fence info string.
  const citation = /^(\d+):(\d+):(\S+)$/.exec(info)
  if (citation) {
    const [, from, to, path] = citation
    const fileName = path.split('/').pop() || path
    const extension = fileName.slice(fileName.lastIndexOf('.') + 1)
    language = hljs.getLanguage(extension) ? extension : ''
    label = `${fileName}:${from}-${to}`
  }

  return `<div class="code-block">
    <div class="code-toolbar">
      <span>${escapeHtml(label || 'text')}</span>
      <button class="copy-code" type="button" aria-label="Copy code">Copy</button>
    </div>
    <pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ''}">${highlight(token.content, language)}</code></pre>
  </div>`
}

export const renderMarkdown = (source: string) => md.render(source)
