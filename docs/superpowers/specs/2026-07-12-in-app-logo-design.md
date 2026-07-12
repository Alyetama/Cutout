# In-app logo

## Goal

Make Cutout's displayed logo match installed application icon.

## Design

Replace inline `Logo` artwork in `src/App.tsx` with SVG matching `icon-src/icon.svg`:

- dark indigo rounded-square shell;
- violet circular accent ring;
- light checkerboard field representing transparency;
- white subject silhouette.

Keep existing `26px` header and `72px` hero/drop sizes. Preserve `aria-hidden`; no behavior, layout, or color-token changes outside mark.

## Verification

Run production frontend build. Inspect rendered SVG at both sizes for recognizable silhouette and no clipping.
