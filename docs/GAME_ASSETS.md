# Game assets: sprites, sheets, tiles, palettes

How to turn pictures into game-ready assets with RSMPS: sprite sheets in and out, tilesets, pixel-art looks, a palette
shared by a whole set, and the export settings engines like. All of it works from the command line too (`docs/CLI.md`).

Nodes used here (all in the Add menu, search by the keywords in brackets):

| Node | What it does |
| --- | --- |
| Sprite Sheet In (spritesheet, atlas, slice, aseprite) | plays a sheet's cells as an animation, or hands each cell to the graph as a batch item |
| Output, kind Sprite sheet | writes the sheet and its metadata; presets for engines |
| Pixel Outline (outline, selout) | hard pixel outline, inside / outside, 4 or 8 connected, selective color, per side |
| Sprite Shadow | drop, ground or contact shadow, solid or dithered |
| Pixel Cleanup | hard alpha, stray pixels, 1 px holes, edge color, optional elbow trimming |
| Palette Lock (palette, snap, validate) | snaps to a palette, highlights or reports off-palette pixels |
| Batch Palette | one palette for a set of sprites (a process: press Extract shared palette once) |
| Make Seamless (tileable) | makes a texture or tile repeat without a seam |
| Autotile / Tileset Map | five pieces to a 47 or 16 tile set; a mask painted with that set |
| Normal Map, Material 2D | lit sprites and normal maps (built by the materials work, see `docs/RECIPES.md`) |

## The batch workflow: many sprites in, one sheet out

1. **Media In**: add all the sprite pictures (each is one batch item) or one animation.
2. A look chain: Pixelate (if they are not pixel art yet) > Pixel Cleanup > Palette Lock (shared palette) > Pixel Outline > Sprite Shadow.
3. **Output**, kind `Sprite sheet`, `Sheet from: All batch items`: ONE sheet holding every sprite, one animation tag per file name.
   With `Each clip` (the default) you get one sheet per file instead. Kind `Still image` writes one PNG per sprite.

Everything before the Output runs once per item, so every sprite gets the same treatment. In the app the Export dialog exports
the batch; on the command line: `rsmps render look.rsmps.json sprites/*.png --out out --for godot`.

## Sprite Sheet In

Give it a sheet (wire a picture to **Sheet**, or add the file to **Sheet file**). Wire sheets at full size: cell sizes are in
sheet pixels (Media In scales big pictures down unless Full resolution is on).

**Slice by**

- *Grid*: columns x rows, or cell size, with margin (around the grid) and spacing (between cells). Cells that do not fit are dropped.
- *Gaps between sprites*: finds the sprites by the transparent space around them (8-connected regions, merged when closer than
  Join gap, tiny specks dropped, then ordered into rows top to bottom and left to right). One analysis per sheet, remembered
  while you play. Smaller sprites sit in the common cell by **Anchor** (bottom center keeps feet on the ground).
- *Metadata JSON*: paste the JSON that **Aseprite** (Export Sprite Sheet, JSON Data array or hash), **TexturePacker** (JSON hash
  or array) or this app's Output writes. You get frame rectangles, trimmed frames put back at their original offset and size
  (Restore trim), per-frame durations (Timing: Durations from metadata) and named animations (Animation: the tag name).
  Rotated frames are refused with a message (export without rotation). Pasting is needed because `.json` is not an asset type yet.

**Playback**: Frames (`2-7`), Order (rows, columns, or a custom list `0,1,2,1`), Frame rate, Ping-pong, Loop, Hold last. Outputs:
the cell (its own size, hard pixels, unit 1), `Frame` (the sheet frame shown) and `Count` (cells in the selection).

**Play as batch items**: batch item N shows cell N, so the whole downstream graph runs per sprite and an Output writes one file
each, or re-packs a sheet (see Sheet from). Limit: the batch size comes from the longest list of files on any node of the graph,
not from the sheet, so with one sheet the graph has one item. Give the batch its size by listing a file once per cell (Media In
or Sprites) or use a Media In with that many files. A future kernel hook (`batchCount` reading a node's own count) removes this.

## Sprite sheet out

Output node, `Export as: Sprite sheet`. The first group of settings:

| Setting | Meaning |
| --- | --- |
| Sheet layout | Grid (uses Sheet columns, 0 = about square), Single row, Single column, Packed |
| Sheet padding | gap between cells, texels |
| Extrude | edge pixels repeated N texels around each frame (stops texture bleeding when an engine filters) |
| Trim frames | cut transparent borders; offsets go to the metadata |
| Power of two | every page rounded up to 2, 4, ... 1024 |
| Max sheet size | 0 = one page; otherwise more pages (`name.png`, `name_2.png`, ...) |
| Packed | deterministic shelf packer, tallest first (same frames and settings give the same bytes) |
| Write pivot | origin of every frame, 0..1 of the original frame, y down |
| Metadata | Generic JSON (default), Aseprite JSON, TexturePacker JSON, CSS sprites, None |
| Sheet from | each clip, or ONE sheet with every batch item |
| Animation name | tag name (default: the source file name) |

With the defaults the output is exactly what older versions wrote (a plain grid, a `.json` with the same keys, plus the new ones).
The plain grid is copied on the GPU; the other layouts read the frames back and assemble them on the CPU (the frames of one sheet
must fit in 1.5 GB).

### Metadata formats

- **Generic JSON** (`format: "rsmps-spritesheet"`): `image`, `width`, `height`, `frameWidth`, `frameHeight`, `columns`, `rows`,
  `padding`, `extrude`, `frameCount`, `fps`, `loop`, `frameDuration` (seconds), `frames[]` (`index`, `name`, `page`, `x`, `y`, `w`, `h`,
  `offsetX`, `offsetY`, `sourceWidth`, `sourceHeight`, `duration` in seconds, optional `pivot`), `tags[]` (`name`, `from`, `to`,
  `direction`), and `images` / `pages` when there is more than one page.
- **Aseprite JSON** (array form): `frames[]` with `filename`, `frame`, `rotated`, `trimmed`, `spriteSourceSize`, `sourceSize`,
  `duration` (ms) and `meta` with `image`, `size`, `frameTags`. Several pages write one file per page (`name_2.json`); tags then
  are left out (their numbers are per file).
- **TexturePacker JSON** (hash form): `frames{}` with `frame`, `rotated`, `trimmed`, `spriteSourceSize`, `sourceSize`, optional
  `pivot`, and `meta`. The format has no animation data.
- **CSS sprites**: `.name-N { width; height; background-position }` per frame and a `@keyframes` per tag (each step held with
  `steps(1, end)`).
- All of them are read back by Sprite Sheet In (a test exports with trim, packing and extrude and checks every frame pixel for pixel).

The label says "Aseprite" / "TexturePacker" for the layout of their files; the files say `app: "RSMPS"`.

### Alpha handling

Exported PNGs are **straight (non-premultiplied) alpha**. Inside the app pictures are premultiplied, and a browser canvas
loses the color under fully transparent pixels. Engines that filter textures (bilinear / mipmaps) average that hidden color
into the edge, which shows as a dark fringe. **Bleed color** (Output > Game export) fills the color of every fully transparent
pixel with the nearest opaque pixel's color (the alpha stays 0). With it on, PNGs are written by the app's own encoder
(straight alpha, deterministic) instead of the canvas. Semi-transparent pixels are never changed. If your art is pixel art drawn
with hard alpha, you never needed it; if you use Pixelate with soft edges and linear filtering in the engine, turn it on.

### Engine presets ("For")

Starting points, not guarantees about an engine's current UI. A preset overrides the sheet fields it lists (pick Generic to set
them yourself); the file is always a PNG with straight alpha. Nearest-neighbor enlargement stays your choice (Pixel upscale).

| For | Sets | Why / how to use |
| --- | --- | --- |
| Generic | nothing | your settings |
| Godot | grid, no trim, no padding / extrude, bleed color, generic JSON | Godot 4 imports the PNG as a Texture2D. Cut frames with the script below. Set the texture filter to Nearest for pixel art |
| Unity | grid, power of two, bleed color, generic JSON | import as Sprite (Multiple), Filter Mode Point; slice with Grid By Cell Size (the cell size is `frameWidth` x `frameHeight`) or script from the JSON. Unity's own `.meta` slicing is not written (fragile, version dependent) |
| GameMaker | single row, bleed color, no metadata | a strip of equal frames, the import dialog asks for the frame count (the name `name_strip6.png` also tells it in recent versions: check yours) |
| RPG Maker | grid with 3 columns, no metadata | the MV / MZ character layout is 3 walk frames across and 4 rows (down, left, right, up) per character: author your clips in that order and use one sheet per character with the `$` file prefix |
| Web | grid, bleed color, CSS | a stylesheet with a class per frame and a keyframes animation per tag; use `image-rendering: pixelated` |

**Godot: what was NOT done.** A Godot 4 `.tres` SpriteFrames resource was not written: its text format (resource ids, uid lines,
format version) differs between 4.x releases and could not be checked here, and a wrong file is worse than none. Instead use the
generic JSON with this editor script (Godot 4, run with File > Run in the script editor; edit the two paths):

```gdscript
@tool
extends EditorScript

func _run() -> void:
	var json_path := "res://sprites/hero.json"
	var meta = JSON.parse_string(FileAccess.get_file_as_string(json_path))
	var texture: Texture2D = load("res://sprites/" + meta.image)
	var frames := SpriteFrames.new()
	frames.remove_animation("default")
	for tag in meta.tags:
		frames.add_animation(tag.name)
		frames.set_animation_loop(tag.name, meta.loop)
		frames.set_animation_speed(tag.name, meta.fps)
		for i in range(tag.from, tag.to + 1):
			var f = meta.frames[i]
			var atlas := AtlasTexture.new()
			atlas.atlas = texture
			atlas.region = Rect2(f.x, f.y, f.w, f.h)
			# trimmed frames: margin puts the sprite back where it was
			atlas.margin = Rect2(f.offsetX, f.offsetY, f.sourceWidth - f.w, f.sourceHeight - f.h)
			frames.add_frame(tag.name, atlas, f.duration * meta.fps)
	ResourceSaver.save(frames, "res://sprites/hero_frames.tres")
```

(Single page sheets. The `duration` is in seconds; `add_frame` takes it relative to the animation speed. Check the method names
against your Godot version.)

**Unity: not done.** Only the generic JSON plus the note above.

## Pixel looks

- **Pixel Outline**: `Position` outside / inside / both; `Corners` 4-connected (plus shape) or 8-connected (ring);
  `Color from` one color / darker neighbor (selective outline: each outline pixel takes the color of the sprite pixel it
  touches, darkened) / palette (that color snapped to a palette); Sides Top / Bottom / Left / Right (only Bottom + Right is a
  drop-shadow style edge); Width in art pixels; Second outline. It works per art pixel, also on an art grid after a masked
  Pixelate. Sprite Outline (Stylize) is the smooth, anti-aliased stroke: use Pixel Outline for crisp sprites.
- **Sprite Shadow**: Drop shadow (offset copy), Ground shadow (flattened, skewed, toward or away from the viewer, from a ground
  line), Contact blob (ellipse); Transparency Solid blend, Dither (Bayer 4 x 4 by Opacity), Checkerboard, Scan lines: the
  patterns use fully opaque shadow pixels, so no new colors appear. The shadow is behind the sprite and clipped to the picture:
  leave room.
- **Pixel Cleanup**: Hard alpha + cutoff, Fix edge colors (a partly transparent pixel takes the color of its solid neighbors),
  Remove strays (no solid 8-neighbor), Fill 1 px holes (4 solid neighbors; their most common color), Trim elbows (off by
  default; every other corner pixel of a one-pixel staircase, so a line steps diagonally).
- **Normal Map** and **Material 2D** (another work item) light sprites: wire Pixel Outline's result into Normal Map with
  `4 / 8 direction pixel-art normals`, or into Material 2D with per-art-pixel lighting.

## Palettes

- **Palette Lock**: snap (nearest palette color in OKLab), highlight (off-palette pixels painted the marker color, magenta by
  default) or report (nothing changes). Number outputs `Off palette` (fraction of opaque pixels that are not exactly a palette
  color before snapping) and `Colors` (distinct colors leaving the node: after snapping in snap mode, of the input otherwise).
  They are only computed when something is wired to them. Snap / highlight count a copy of the art grid at most 128 pixels on
  its longest side (exact for sprites up to that size); report mode counts the whole picture exactly. Both are remembered.
  Dithering is not here: use Dither or Quantize before it.
- **Batch Palette**: a node never sees the other batch items, so the set is named explicitly. Add the files to *Sprites* (the
  same files as Media In) and / or wire a clip and set *Clip samples*, then press *Extract shared palette*. The job reads every
  picture once (at most 128 pixels on the long side), pools the colors and extracts ONE palette that is saved with the project
  and served for every item. Until then it shows the palette of the current picture alone. Wire its output into Palette Lock.
  Exports need it done (or `--process` on the command line). Caveat: the Sprites list counts for the batch size like any file list.
- **Export report** (command line): `--report json|text` writes `export-report.json` / `.txt` next to the files: per image file
  the size, number of colors, frames, bytes and, when a Palette Lock is upstream of the Output, the off-palette fraction.

## Tiles

### Make Seamless

Same size in, same size out. *Offset blend*: the picture is shifted by half its size and laid under the original, which fades
out toward the borders (soft cross in the middle, matching borders). *Mirror*: the second half is the first half reflected
(no blending, no new colors; the symmetric look is the price). *Edge match*: each border is pulled toward the other over Width
pixels. Axis Both / Horizontal / Vertical. *Pixel art*: the fades become ordered dither between existing colors (automatic on an art grid).
To look at the result use **Array**: Mode Grid, Columns 3, Rows 3, Gap 0, Output size Same as input (there is no separate
"Tile Preview" node: Array already does exactly this, including a brick offset in Grid mode).

### Autotile: the five pieces

Draw five equal squares (T x T, 16 x 16 for example) in ONE row, left to right (picture 5T x T):

```
 1 center    2 edge       3 outer corner   4 inner corner   5 single
 ########    ........     ........         ..######         ........
 ########    ########     ..######         ########         ..####..
 ########    ########     ..######         ########         ..####..
 ########    ########     ..######         ########         ........
 (all        (terrain     (terrain to the  (terrain all     (an island, as it
 terrain)    below, empty bottom right;    around, only     should look with no
             above)       empty N and W)   NW diagonal      neighbors)
                                           empty)
 #  terrain      .  empty
```

Everything is drawn with the empty side on top and the corner at the top left; the node turns the pieces by whole quarter
turns. Every output tile is put together from four quarter tiles:

| neighbors of that quarter | taken from |
| --- | --- |
| both orthogonal ones empty | outer corner |
| one empty | edge, turned to face the empty one |
| both terrain, diagonal empty | inner corner |
| both terrain, diagonal terrain | center |
| nothing around the whole tile | single |

Outputs: **47 tile blob** set (8 columns x 6 rows, tile i = the i-th of the 47 distinct neighborhoods in ascending mask order,
the 48th slot empty) or the **16 tile edge** set (4 x 4, tile number = N + 2 E + 4 S + 8 W). The 8-bit mask is
N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128, a diagonal counting only when both its orthogonal neighbors are terrain:
the list is 0, 1, 4, 5, 7, 16, 17, 20, 21, 23, 28, 29, 31, 64, 65, 68, 69, 71, 80, 81, 84, 85, 87, 92, 93, 95, 112, 113, 116, 117,
119, 124, 125, 127, 193, 197, 199, 209, 213, 215, 221, 223, 241, 245, 247, 253, 255. This is **its own layout**: Godot terrains,
Tiled and RPG Maker each want theirs (RPG Maker's A2 autotile is a different 2 x 3 sub-tile scheme and is not produced here),
so import the PNG and assign the tiles by mask number from this table.

### Tileset Map

Wire a mask (white = terrain) and the tileset (as Autotile writes it, with the same layout setting). The mask is cut into map
cells (`Mask cell` pixels each; 1 means the mask is already one pixel per tile), the eight neighbors of every terrain cell give
the bitmask, the bitmask picks the tile. A blobby painted mask becomes a properly edged terrain image of
`cells x tile size` pixels. `Beyond the map: Terrain` lets the border continue without an edge. One GPU pass.

## Not included

- Aseprite `.aseprite` files and TexturePacker `.tpsheet` are not read (export the JSON next to the PNG).
- Rotated frames in sheets (TexturePacker "allow rotation").
- Godot `.tres`, Unity `.meta` (see above), RPG Maker A2 autotile layout.
- Importing the `.json` as a library asset (it is pasted into Sprite Sheet In).
