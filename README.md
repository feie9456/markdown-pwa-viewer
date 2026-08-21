# Markdown PWA Viewer

A lightweight, read-only Markdown viewer built with React + Vite and packaged as an installable PWA.

## Features

- Open local `.md` / `.markdown` files
- Drag-and-drop Markdown files
- PWA file handling via `file_handlers` + `launchQueue`
- Left-side document outline generated from headings
- KaTeX math rendering (`$...$` / `$$...$$`)
- Mermaid diagrams via fenced `mermaid` blocks
- Syntax highlighting with highlight.js
- One-click code copy
- Responsive layout and automatic dark mode
- Offline support through the service worker
- Automatic GitHub Pages deployment from `main`

## Local development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## GitHub Pages

`.github/workflows/deploy-pages.yml` builds the app and deploys `dist/` to GitHub Pages whenever `main` is updated.

The Vite production base path is configured for:

```text
/markdown-pwa-viewer/
```

After the first deployment, the expected Pages URL is:

```text
https://feie9456.github.io/markdown-pwa-viewer/
```

If GitHub Pages has not been enabled for this repository yet, open **Settings → Pages** and choose **GitHub Actions** as the source.

## Install as a PWA

Open the deployed site in desktop Chrome or Edge and install it from the browser's install-app control.

The manifest registers handlers for:

- `.md`
- `.markdown`

On Chromium-based desktop browsers that support the File Handling API, launching an associated Markdown file is delivered to the app through `launchQueue` and rendered immediately.

You may still need to choose **Markdown PWA Viewer** as the default application for Markdown files in your operating system after installation.

> File association support is browser/OS dependent. Chromium desktop currently provides the relevant PWA File Handling API; Safari does not provide equivalent support.

## Markdown examples

### Math

```markdown
Inline: $E = mc^2$

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$
```

### Mermaid

````markdown
```mermaid
flowchart LR
  Markdown --> Parse
  Parse --> Preview
```
````

## Security model

Raw HTML in Markdown is disabled. Mermaid is initialized with `securityLevel: 'strict'`. The application is designed as a local read-only previewer rather than an editor or document manager.
