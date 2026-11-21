"""把 agentbus skill + runtime 打成一个可分发 zip。

用法：python make-skill-zip.py
产出：dist/agentbus-skill-0.1.1.zip

排除：data/（含 token 与消息台账）、config.json（含账号密码）、dist/ 自身。
"""
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "0.1.1"
OUT_DIR = os.path.join(ROOT, "dist")
OUT = os.path.join(OUT_DIR, f"agentbus-skill-{VERSION}.zip")

INCLUDE = [
    ("SKILL.md", "SKILL.md"),
    ("SKILL.generic.md", "SKILL.generic.md"),
    ("INSTALL.md", "INSTALL.md"),
    ("README.md", "runtime/README.md"),
    ("package.json", "runtime/package.json"),
    ("config.example.json", "runtime/config.example.json"),
]
SRC_GLOB = "src"
TEST_GLOB = "test"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    files = []
    for src, dst in INCLUDE:
        p = os.path.join(ROOT, src)
        if os.path.exists(p):
            files.append((p, dst.replace("/", os.sep)))
        else:
            print(f"跳过（不存在）：{src}")

    src_dir = os.path.join(ROOT, SRC_GLOB)
    for name in sorted(os.listdir(src_dir)):
        if name.endswith(".js"):
            files.append((os.path.join(src_dir, name), os.path.join("runtime", "src", name)))

    test_dir = os.path.join(ROOT, TEST_GLOB)
    if os.path.isdir(test_dir):
        for name in sorted(os.listdir(test_dir)):
            if name.endswith(".js"):
                files.append((os.path.join(test_dir, name), os.path.join("runtime", "test", name)))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for p, rel in files:
            z.write(p, os.path.join("agentbus", rel))

    size = os.path.getsize(OUT)
    print(f"{OUT}  ({size/1024:.1f} KB, {len(files)} 个文件)")
    for _, rel in files:
        print("  agentbus/" + rel.replace(os.sep, "/"))


if __name__ == "__main__":
    main()
