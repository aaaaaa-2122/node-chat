#!/usr/bin/env python3
"""生成 App 图标（聊天气泡），输出到 app/res/mipmap-*/ic_launcher.png。

用法: python3 tools/make-icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "res")

DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

BG_TOP = (76, 141, 255)
BG_BOTTOM = (43, 86, 190)
BUBBLE = (255, 255, 255)
DOT = (76, 141, 255)


def draw_icon(size: int) -> Image.Image:
    s = size * 4  # 超采样后再缩放，边缘更平滑
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角方形背景 + 竖向渐变
    grad = Image.new("RGBA", (1, s))
    gd = ImageDraw.Draw(grad)
    for y in range(s):
        t = y / max(1, s - 1)
        gd.point((0, y), fill=(
            int(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
            int(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
            int(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
            255,
        ))
    grad = grad.resize((s, s))

    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # 气泡主体
    pad = int(s * 0.17)
    body = [pad, int(s * 0.20), s - pad, int(s * 0.66)]
    d.rounded_rectangle(body, radius=int(s * 0.13), fill=BUBBLE)

    # 气泡尾巴
    tail = [
        (int(s * 0.32), int(s * 0.64)),
        (int(s * 0.32), int(s * 0.82)),
        (int(s * 0.50), int(s * 0.66)),
    ]
    d.polygon(tail, fill=BUBBLE)

    # 三个点
    cy = int(s * 0.43)
    r = int(s * 0.045)
    for i in range(3):
        cx = int(s * (0.36 + 0.14 * i))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    for density, size in DENSITIES.items():
        out_dir = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, "ic_launcher.png")
        draw_icon(size).save(path, "PNG")
        print(f"✅ {path} ({size}x{size})")

    # 桌面端预览图（README 用）
    draw_icon(256).save(os.path.join(ROOT, "docs", "icon-256.png"), "PNG")
    print("✅ docs/icon-256.png")


if __name__ == "__main__":
    main()
