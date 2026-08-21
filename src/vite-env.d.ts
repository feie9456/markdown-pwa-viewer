/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module 'markdown-it-texmath' {
  import type MarkdownIt from 'markdown-it'
  import type katex from 'katex'

  type TexmathOptions = {
    engine: typeof katex
    delimiters?: string
    katexOptions?: Record<string, unknown>
  }

  const texmath: (md: MarkdownIt, options: TexmathOptions) => void
  export default texmath
}
