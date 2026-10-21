# Windows brand icons

The source is the existing desktop shell bear, `../logo.png` (SHA-256
`da8ccb19fea781c30a45f6f7ae9f8190bebeec53d4456a5152d9cdeee9961b03`). The source artwork stays unchanged.
On October 21, 2026 the owner requested the same icon in the taskbar and tray. The coordinator selected
the shell's existing navy `#0B1120` as a solid backing: the transparent white bear disappears against a
light Windows taskbar. There is no recolouring, badge, health marker or new artwork.

These derived assets are committed; ordinary builds only copy them and need no image tool or new
dependency. They were generated offline with Pillow 12.3.0: open the 1024 x 1024 source as RGBA, resize
its full canvas with `Image.Resampling.LANCZOS` to each square size (16, 20, 24, 32, 48, 64, 128, 256),
alpha-composite onto an opaque RGBA `#0B1120` image of that size, and save PNG with `compress_level=9`.
The ICO contains those exact eight PNG payloads in ascending size, one plane and 32 bits per pixel;
256 is encoded as zero in the ICO directory's one-byte dimensions. No extra crop or second resize is
applied. If regenerating, preserve the source hash and inspect actual-size samples on light and dark
backgrounds before replacing the derivatives. PNG encoding bytes may differ across Pillow versions.

The tray loads 16/20/24/32 px representations at scale factors 1/1.25/1.5/2. The dashboard and Forge use
`brand.ico`, including the larger frames for Windows shell surfaces. `scripts/inspect-package.mjs`
compares bundled assets with these files and verifies the actual primary icon resources in the EXE
(and in Setup with `--installer`), using Packager's already locked resource reader without executing
application or installer code. Source/build and package fingerprints include the icon assets.
