# Markdown PWA Viewer

A lightweight, read-only Markdown viewer built with React + Vite and packaged as an installable PWA.

## Features

- Drag-and-drop one or more `.md` / `.markdown` files directly into the viewer
- PWA file handling via `file_handlers` + `launchQueue` for OS-level file association
- Multiple tabs with per-tab scroll-position preservation
- Recent-files menu to the left of the tab strip
- IndexedDB persistence for recent documents, open tabs, active tab, scroll positions, and Markdown content snapshots
- `FileSystemFileHandle` persistence when supported by the browser, with snapshot fallback otherwise
- Previous tabs and content restored after refresh/relaunch
- Live reload when a persistent local file handle is available
- Left-side document outline generated from headings
- Active outline item follows the document using absolute heading positions + binary search
- KaTeX math rendering (`$...$` / `$$...$$`)
- Mermaid diagrams via fenced `mermaid` blocks
- Syntax highlighting with highlight.js
- One-click code copy
- Responsive layout and automatic dark mode
- Offline support through the service worker
- Automatic GitHub Pages deployment from `main`

The viewer intentionally has no editor or file-open toolbar. Use OS file association, drag-and-drop, tabs, or the Recent menu to work with documents.

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

Expected Pages URL:

```text
https://feie9456.github.io/markdown-pwa-viewer/
```

If GitHub Pages has not been enabled for this repository yet, open **Settings → Pages** and choose **GitHub Actions** as the source.

## Install as a PWA

Open the deployed site in desktop Chrome or Edge and install it from the browser's install-app control.

The manifest registers handlers for:

- `.md`
- `.markdown`

On Chromium-based desktop browsers that support the File Handling API, launching an associated Markdown file is delivered to the app through `launchQueue` and opened as a tab.

You may still need to choose **Markdown PWA Viewer** as the default application for Markdown files in your operating system after installation.

> File association support is browser/OS dependent. Chromium desktop currently provides the relevant PWA File Handling API; Safari does not provide equivalent support.

## Persistence and recent files

Documents are stored locally in IndexedDB. The viewer keeps a Markdown content snapshot so the previous session can be restored after a refresh even when the browser cannot immediately reopen the original file.

When Chromium allows `FileSystemFileHandle` objects to be structured-cloned into IndexedDB, the handle is stored as well. On a later restore the viewer tries to read the real file again; if permission is unavailable it falls back to the stored snapshot. Clicking an item in the Recent menu provides a user gesture that can be used to request file permission again.

Closing a tab does not remove the document from Recent files.

## Live reload

When a tab has a readable `FileSystemFileHandle` (for example from PWA file association or compatible Chromium drag-and-drop), the viewer checks file metadata once per second. If the file changes on disk, that tab refreshes automatically.

If the browser only exposes a one-time `File` snapshot for a drag operation, the document still renders and persists normally but cannot be watched for later changes.

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

Raw HTML in Markdown is disabled. Mermaid is initialized with `securityLevel: 'strict'`. The application is designed as a local read-only previewer rather than an editor.
