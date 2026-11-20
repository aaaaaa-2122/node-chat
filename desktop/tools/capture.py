# -*- coding: utf-8 -*-
"""按窗口标题截图（PrintWindow，不受遮挡影响）。
用法: python capture.py "Node Chat" out.png
"""
import ctypes
import sys
from ctypes import wintypes

try:
    from PIL import Image
except ImportError:
    sys.exit("需要 Pillow: pip install pillow")

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

SW_RESTORE = 9
title = sys.argv[1]
out = sys.argv[2]

hwnd = user32.FindWindowW(None, title)
if not hwnd:
    print("NOT FOUND")
    sys.exit(2)

user32.ShowWindow(hwnd, SW_RESTORE)
user32.SetForegroundWindow(hwnd)

rect = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top

hdc = user32.GetWindowDC(hwnd)
mem = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mem, bmp)

ok = user32.PrintWindow(hwnd, mem, 2)
if not ok:
    ok = user32.PrintWindow(hwnd, mem, 0)

buf = ctypes.create_string_buffer(w * h * 4)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]

bi = BITMAPINFOHEADER()
bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.biWidth = w
bi.biHeight = -h
bi.biPlanes = 1
bi.biBitCount = 32
bi.biCompression = 0

gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1)
img.convert("RGB").save(out)

gdi32.DeleteObject(bmp)
gdi32.DeleteDC(mem)
user32.ReleaseDC(hwnd, hdc)
print("saved %s (%dx%d) printwindow=%d" % (out, w, h, ok))
