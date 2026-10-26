#!/usr/bin/env python3
"""Check the editor's preview core against the exact reference: the cases
tools/look_check.mjs writes (random strips and looks, and sim.js lookBlocks'
answer) against tools/sim_look.py look_blocks.

  node tools/look_check.mjs 40 | uv run --with numpy tools/look_check.py
"""
import base64, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sim_look import look_blocks

fail = 0
for i, c in enumerate(json.load(sys.stdin)):
    w, h, p = c['w'], c['h'], c['p']
    Y = np.frombuffer(base64.b64decode(c['Y']), np.uint8).reshape(h, w)
    UV = np.frombuffer(base64.b64decode(c['UV']), np.uint8).reshape(h // 2, w // 2, 2)
    js = np.frombuffer(base64.b64decode(c['idx']), np.uint8).reshape(h // 2, w // 2)
    py = look_blocks(Y, UV, p)
    bad = (py[:js.shape[0], :js.shape[1]] != js).mean() * 100
    fail |= bad > 0
    print(f"case {i}: {w}x{h}, {len(p['match'])} colours, ramp {p.get('ramp')}, tone {p.get('gbTone')}, "
          f"pixel {p.get('pixel')}, sharpen {p.get('sharpen')}: {'same' if bad == 0 else f'{bad:.2f}% DIFFERENT'}")
print('look check', 'FAILED' if fail else 'PASSED')
sys.exit(1 if fail else 0)
