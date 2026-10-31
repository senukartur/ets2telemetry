# Desktop UI design

The design target for the desktop application and its overlay, in the Yukon Union community style (October 19, 2026). Start with [ui-spec.md](ui-spec.md).

| File | Contents |
| --- | --- |
| [ui-spec.md](ui-spec.md) | Rules, components, screens, data bindings, states, overlay, localization and a suggested implementation order |
| [tokens.css](tokens.css) | Colour, type and shape tokens, the shadcn variable mapping and the overlay tokens |
| [mockup.html](mockup.html) | Interactive mockup. Open it in a browser (it needs the `assets` folder next to it). Use **Inspect** to see spec ids, and switch language, game, connection and Hard Mode state |
| [assets/logo.png](assets/logo.png) | The application logo, 1024 × 1024 white line art on transparency; usage rules in [ui-spec.md §3](ui-spec.md#3-tokens-type-and-icons) |
| [assets/app-icon.png](assets/app-icon.png) | 256 px preview of the "road merge" taskbar, desktop and tray icon drawn by `scripts/generate-app-icons.mjs`; rules in [ui-spec.md §3](ui-spec.md#3-tokens-type-and-icons) |

The mockup inlines a copy of the tokens so it can run on its own and makes no network request; tokens.css is the source of truth. It uses M PLUS Rounded 1c only if the font is installed locally and otherwise falls back to Segoe UI; the application bundles M PLUS Rounded 1c instead (ui-spec.md §3). All values shown in the mockup are invented examples.

**Checking the mockup.** The page exposes `globalThis.__mock` (`S`, `render`, `I18N`, `screenHtml`) so a script can render every screen and state without a browser, check that each English string key has a Russian entry, and look for missing keys (`⟦key⟧`), `undefined` or `NaN` in the output. This is how the mockup was checked when it was added: 3,072 combinations rendered without either.

This folder is a design reference. It does not implement anything and does not authorize implementation; each package needs its own card.
