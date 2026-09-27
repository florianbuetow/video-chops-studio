# Video Chops Studio

A local video editor for cropping, trimming, and cutting clips. The interface follows the light sidebar, white panels, blue accents, and compact controls of `carousell-card-creator-studio`.

## Start

Requires Node.js 24+, npm, and **FFmpeg** with `ffmpeg` and `ffprobe` on your PATH. On macOS, install FFmpeg with `brew install ffmpeg` if it is missing.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:4310**. Put videos in **`data/input/`** and click **Refresh files**. MP4, MOV, M4V, WebM, MKV, and AVI sources are supported. The server binds only to this computer.

`npm run dev` builds before starting. After making source changes, restart it to rebuild. `npm start` starts an existing build; `just studio` builds and starts the editor.

## Edit and export

1. Select a source in the sidebar. The first load prepares a browser-compatible preview locally; longer videos take more time.
2. **Crop:** drag the frame or resize its corners. Choose an aspect ratio, or enter exact pixel dimensions and position. **Cropped preview** shows the output framing. Pixel values snap to even numbers for H.264 encoding.
3. **Trim:** drag the selected clip’s timeline edges, edit its In/Out seconds, or use **Set in here** and **Set out here** at the playhead.
4. **Cut:** move the playhead and click **Split**. Split again at the end of an unwanted section, select that section, and click **Remove clip**. Remaining clips are joined in source order. **Skip removed sections** previews the cuts.
5. Choose an `.mp4` file name and whether to retain audio. Click **Export MP4** in the right-hand editing panel. Progress and a download link appear when it is ready.

Exports are written directly to **`data/output/`** as H.264 MP4 with AAC audio when retained. The download link is optional. Existing output files are never overwritten; choose another name to export another version. Inputs are never modified. Export uses the original source resolution, even when the preview is downscaled.

Undo/redo and per-source drafts are kept for the current page session. Reloading clears the edits. The preview cache is temporary and removed when the server shuts down. Stop the server with **Shut down studio** at the bottom of the sidebar, `just stop`, or Ctrl+C; an active export finishes before shutdown. After a shutdown from the sidebar, the page reloads two seconds later.

## Combine two video regions

1. Click **Two Regions** in the right panel’s **Layout** controls. The **Source** and **Output** canvases appear together. Gray surrounds and aspect-ratio badges make the actual video and output boundaries visible.
2. Click **Draw 1**, then drag a rectangle over the source video. Repeat with **Draw 2**. You can move either source rectangle and resize its corners, or expand **Source bounds** for exact pixel coordinates.
3. Choose the **Output canvas** aspect ratio. Presets include square (1:1), landscape and portrait (16:9, 9:16, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5), and ultrawide (21:9).
4. Choose **Vertical** or **Horizontal** stacking and set the gap with the slider or pixel field. Each direction remembers its own gap. The regions are centered as a group, and changing the output preset keeps the chosen direction and gap (clamped to fit). You can also drag the regions in **Output** to position them freely, or drag a corner or change **Selected region size** to resize proportionally. The maximum is 100% of the selected source pixels; the regions are never upscaled. **Reapply stack** restores the selected arrangement.
5. Expand **Background & frame** to choose a canvas color, upload a PNG/JPG/WebP background (up to 20 MB), or add a frame around the video regions or the whole canvas. Images fill the canvas with a centered crop; transparent areas reveal the canvas color. Frame color and thickness are adjustable.
6. Use **Play output** beneath the output canvas to preview both regions with audio and your retained cuts. Its timecode shows time within the edited result. Playback is live, without a separate composition render.
7. Trim or cut the timeline as usual, then **Export MP4**. Both regions show the same moment of the source, with one shared audio track. If you overlap regions, region 2 appears above region 1.

Arrow keys move a focused output region by 2 pixels; Shift+arrows move it by 20 pixels. On a corner handle, arrows resize it. Uploaded backgrounds are stored in `data/input/` as normalized PNG assets. Switching back to **One Region** keeps its earlier crop, and undo/redo includes stacking direction, gaps, region positions, output presets, backgrounds, and frames.

## Keyboard controls

| Key                  | Action                                 |
| -------------------- | -------------------------------------- |
| Space                | Play or pause                          |
| S                    | Split at the playhead                  |
| I / O                | Set the selected clip’s in / out point |
| Delete / Backspace   | Remove the selected clip               |
| Left / Right         | Step one source frame                  |
| Shift + Left / Right | Step one second                        |
| Cmd/Ctrl + Z         | Undo                                   |
| Cmd/Ctrl + Shift + Z | Redo                                   |

Shortcuts apply when focus is outside form controls. Focus a crop corner and use arrow keys to resize by 2 pixels, or Shift+arrows for 20 pixels. Focus a trim handle and use Left/Right for 0.05 seconds, or Shift+arrows for one second. All drag edits also have labeled numeric fields.

## Custom directories or port

```sh
npm run build
npm run cli -- studio --input /path/to/videos --output /path/to/exports --port 4311
```

All three flags are required for the `studio` command. The input directory must exist; the output directory is created when needed. The standard npm scripts supply `data/input`, `data/output`, and port `4310` explicitly. Sources are read from the top level of the input directory. The UI folder hints describe the standard directories.

The CLI reports its URL as JSON on stdout and diagnostics on stderr. Exit codes are `0` success, `1` runtime failure, and `2` usage error. The template’s `summarize <file|->` CLI and typed API remain available.

## Development and validation

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run test:mutation
```

Tests run offline and generate tiny local video fixtures with FFmpeg. They exercise edit invariants, real crops and cuts, silent and rotated footage, preview caching, path confinement, HTTP streaming, export failures, and the packed npm artifact. `just ci` also runs formatting, spelling, Semgrep, security lint, dependency checks, architecture checks, and CodeQL. Those additional local tools are listed by `just check`.

The app adds no runtime npm dependencies. Node serves the UI and manages FFmpeg via argument arrays. `src/domain/` contains pure video validation and filter construction, `src/application/` owns file and rendering use cases, `src/cli/` owns the HTTP and command adapters, and `src/web/` contains the browser editor. The build includes the HTML, CSS, and browser modules in the packed artifact.
