"""生成 AICheatCode 的 4 个 PNG 图标（16/32/48/128）。
设计：圆角方块 + 紫蓝渐变 + 白色 ▶（与侧边栏/弹窗内嵌 logo 视觉一致）。"""
from PIL import Image, ImageDraw
import os

# 品牌渐变色（与 panel.css 的 --accent-grad 完全一致）
TOPLEFT = (139, 92, 246)   # #8b5cf6
BOTRIGHT = (99, 102, 241)  # #6366f1


def lerp(a, b, t):
    return tuple(int(a[i] * (1 - t) + b[i] * t) for i in range(3))


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1) 圆角矩形（按尺寸等比缩放，16px 时半径 ~3.5px，128px 时 ~28px）
    radius = max(2, int(round(size * 0.22)))

    # 2) 渐变层（对角线：从左上到右下）
    grad = Image.new("RGBA", (size, size))
    denom = max(1, 2 * (size - 1))
    for y in range(size):
        for x in range(size):
            t = (x + y) / denom
            r, g, b = lerp(TOPLEFT, BOTRIGHT, t)
            grad.putpixel((x, y), (r, g, b, 255))

    # 3) 用圆角遮罩把渐变裁成圆角方块
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=radius, fill=255
    )
    img.paste(grad, (0, 0), mask)

    # 4) 白色 ▶ 三角形，居中略偏右（光学居中）
    cx, cy = size / 2, size / 2
    tri_h = size * 0.42
    tri_w = size * 0.36
    offset_x = size * 0.05  # ▶ 视觉重心比几何中心偏右，这里右移补偿
    triangle = [
        (cx - tri_w / 2 + offset_x, cy - tri_h / 2),
        (cx - tri_w / 2 + offset_x, cy + tri_h / 2),
        (cx + tri_w / 2 + offset_x, cy),
    ]
    draw.polygon(triangle, fill=(255, 255, 255, 255))

    return img


def main():
    # 输出到脚本所在目录的上一级（即扩展根目录）/icons/
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for s in (16, 32, 48, 128):
        icon = make_icon(s)
        path = os.path.join(out_dir, f"icon{s}.png")
        icon.save(path, "PNG", optimize=True)
        print(f"  wrote {path} ({icon.size[0]}x{icon.size[1]})")
    print("done")


if __name__ == "__main__":
    main()