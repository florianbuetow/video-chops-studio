# Video Chops Studio design

## Reference

Adapted from `../carousell-card-creator-studio/src/index.css`, `App.css`, and its sidebar and toolbar components. The user requested the same UI style.

## Colors

Light workspace `#f7f8fa`, white panels, sidebar `#f0f2f5`, fine dividers `#e2e5ea`, stronger control borders `#c9ced6`, ink `#1c1f26`, secondary text `#626a77`. Primary actions use blue `#3b73c4`, hover `#2f5fa6`, selection `#e4eefc`. Error text `#b3423e` sits on `#fbe9e8`.

## Typography

Inter, SF Pro Text, system UI, Segoe UI, sans-serif. 14px base, 13px controls, 12px secondary labels, 15px semibold branding. Timecodes use tabular numerals.

## Layout

240px sidebar, main video preview with playback controls and timeline, 300px inspector for crop and export. The workspace starts directly at the top, without a metadata header. Undo, redo, and Reset edits sit at the top of the inspector; its Export section contains the single Export MP4 action. Source names and sizes stay in the file sidebar; its footer holds the local-workspace note and the Shut down studio button. The inspector stacks beneath the preview at narrower widths; the file sidebar becomes a compact strip on mobile, keeping only the shutdown button from its footer.

The One Region and Two Regions buttons switch layouts. Two Regions places synchronized Source and Output canvases side by side, stacking them on narrow screens. Output has its own prominent Play/Pause button and edited-result timecode. Numbered blue and amber rectangles connect source selections to output positions. Vertical and Horizontal buttons arrange regions with a configurable gap in output pixels, remembering a separate gap for each direction. The inspector groups layout, source regions, output size/position, optional background/frame styling, and export. Source bounds and appearance settings use native disclosure controls to keep the panel compact. The longer composition inspector scrolls independently on desktop.

## Components

36px controls, 8px corner radii, single borders, blue selected states, consistent line icons. Source and output frames sit on gray surrounds (`#d5d8de`) with a fine outline and local aspect-ratio badges, clearly separating the canvas from its surroundings even when the video or chosen output background is black. Crop movement, resizing, and stack gaps have numeric alternatives. Inline export progress and downloadable results stay in the inspector.

## Motion

150ms color transitions and immediate timeline manipulation. Respect reduced motion. No decorative entrance animations.
