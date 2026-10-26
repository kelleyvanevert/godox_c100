#!/usr/bin/env python3
"""The exact reference of a look on one strip, integer for integer as the
firmware does it (photo_cave.s lut_fill, video_cave.s fx_strip), for the
emulator checks (emu_cave.py, emu_video.py) and the editor's preview
(site/editor/sim.js, checked against this by tools/look_check.mjs).

A strip is the camera's: Y per pixel (rows x W), U and V per 2x2 block (one
pair per block, rows/2 x W/2 x 2); rows a multiple of 4, starting on a 64-row
boundary, so the dither phase is the strip's own. Per block of the look's
pixel size (2x2, or 4x4 = 2x2 blocks of them):

  1. luma: the mean of its pixels' Y (sum >> 2 or >> 4); U, V: of its pairs
  2. the look's luma map (palettes.py luma_map: contrast, brightness, the
     Game Boy tone)
  3. sharpening (palettes.py sharpen_weight w): y + ((2y - left - right) * w >> 7)
     on the mapped luma of the row (the row's ends repeat), not clamped yet
  4. the dither offset of its position (palettes.py dither_table), clamped
  5. the table: the nearest match colour (2|dY| + |dU| + |dV|, first on a
     tie) at the bin centres (8q, q = (x + 4) >> 3), or for a ramp the even
     shade of the luma bin (palettes.py ramp_shade)

look_blocks gives the colour index per 2x2 block (a 4x4 block's four alike).
"""
import numpy as np
from palettes import WY, dither_table, luma_map, ramp_shade, sharpen_weight


def look_blocks(Y, UV, p):
    """p: a preset as palettes.config() gives it (a ramp's colours already sorted)."""
    s = p.get('pixel', 2)
    Y = Y.astype(np.int64)
    UV = UV.astype(np.int64)
    h, w = Y.shape
    bh, bw = h // s, w // s
    k = s // 2                                            # 2x2 blocks per block side
    luma = Y.reshape(bh, s, bw, s).sum(axis=(1, 3)) >> (2 if s == 2 else 4)
    uv = UV.reshape(bh, k, bw, k, 2).sum(axis=(1, 3)) >> (0 if s == 2 else 2)
    y = np.array(luma_map(p))[luma]
    wgt = sharpen_weight(p)
    if wgt:
        pad = np.pad(y, ((0, 0), (1, 1)), mode='edge')
        y = y + ((2 * y - pad[:, :-2] - pad[:, 2:]) * wgt >> 7)
    d = np.array(dither_table(p)).reshape(4, 4)
    y = np.clip(y + d[np.arange(bh)[:, None] & 3, np.arange(bw)[None, :] & 3], 0, 255)
    q = (y + 4) >> 3
    n = len(p['match'])
    if p.get('ramp'):
        idx = np.array([ramp_shade(i, n) for i in range(33)])[q]
    else:
        m = np.array(p['match'])
        cy, cu, cv = 8 * q, 8 * ((uv[..., 0] + 4) >> 3), 8 * ((uv[..., 1] + 4) >> 3)
        dist = (WY * np.abs(cy[..., None] - m[:, 0]) + np.abs(cu[..., None] - m[:, 1])
                + np.abs(cv[..., None] - m[:, 2]))
        idx = dist.argmin(axis=-1)
    return idx.repeat(k, axis=0).repeat(k, axis=1)
