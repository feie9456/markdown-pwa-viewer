import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import hljs from 'highlight.js'

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

export const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

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

const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const language = token.info.trim().split(/\s+/)[0]

  if (language === 'mermaid') {
    return `<div class="mermaid">${escapeHtml(token.content)}</div>`
  }

  const raw = token.content
  const highlighted = language && hljs.getLanguage(language)
    ? hljs.highlight(raw, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(raw).value

  return `<div class="code-block">
    <div class="code-toolbar">
      <span>${escapeHtml(language || 'text')}</span>
      <button class="copy-code" type="button" aria-label="Copy code">Copy</button>
    </div>
    <pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ''}">${highlighted}</code></pre>
  </div>` || defaultFence(tokens, idx, options, env, self)
}

export const renderMarkdown = (source: string) => md.render(source)
