#!/usr/bin/env bash
#
# Node Chat 安卓端构建（不依赖 Gradle / Android Studio）
#   javac -> d8 -> aapt2 compile/link -> 合入 dex -> zipalign -> apksigner
#
# 用法:
#   ./build.sh
#
# 环境变量:
#   ANDROID_HOME  Android SDK 路径（Windows 默认 D:/dsh1/node/android-sdk，其它平台 /opt/android-sdk）
#   JAVA_HOME     JDK 17 路径（默认自动探测）
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
APP_DIR="$ROOT/app"
OUT_DIR="$ROOT/build"
APK_OUT="$ROOT/dist"

# ------------------------------------------------------------ 工具链定位
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -d "D:/dsh1/node/android-sdk" ]; then
    ANDROID_HOME="D:/dsh1/node/android-sdk"
  elif [ -d "/opt/android-sdk" ]; then
    ANDROID_HOME="/opt/android-sdk"
  fi
fi
if [ -z "${JAVA_HOME:-}" ]; then
  for cand in "C:/Program Files/Java/jdk-17" "C:/Program Files/Eclipse Adoptium/jdk-17" \
              "/opt/tools/jdk17" "/usr/lib/jvm/java-17-openjdk-amd64"; do
    if [ -d "$cand" ]; then JAVA_HOME="$cand"; break; fi
  done
fi
if [ -z "${ANDROID_HOME:-}" ] || [ ! -d "$ANDROID_HOME" ]; then
  echo "❌ 找不到 Android SDK，请设置 ANDROID_HOME" >&2
  exit 1
fi
if [ -z "${JAVA_HOME:-}" ] || [ ! -d "$JAVA_HOME" ]; then
  echo "❌ 找不到 JDK 17，请设置 JAVA_HOME" >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
JAVA="$JAVA_HOME/bin/java"
JAVAC="$JAVA_HOME/bin/javac"

BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)"
PLATFORM_DIR="$(ls -d "$ANDROID_HOME"/platforms/android-* 2>/dev/null | sort -V | tail -1)"
ANDROID_JAR="$PLATFORM_DIR/android.jar"
if [ ! -f "$ANDROID_JAR" ] || [ -z "$BUILD_TOOLS" ]; then
  echo "❌ 缺少 platforms/android-34 或 build-tools，请用 sdkmanager 安装" >&2
  exit 1
fi

AAPT2="$BUILD_TOOLS/aapt2.exe"
[ -x "$AAPT2" ] || AAPT2="$BUILD_TOOLS/aapt2"
ZIPALIGN="$BUILD_TOOLS/zipalign.exe"
[ -x "$ZIPALIGN" ] || ZIPALIGN="$BUILD_TOOLS/zipalign"
D8_JAR="$BUILD_TOOLS/lib/d8.jar"
APKSIGNER_JAR="$BUILD_TOOLS/lib/apksigner.jar"

VERSION_CODE=3
VERSION_NAME=1.1.0

echo "=============================================="
echo " Node Chat 安卓端构建"
echo "   SDK        : $ANDROID_HOME"
echo "   build-tools: $(basename "$BUILD_TOOLS")"
echo "   platform   : $(basename "$PLATFORM_DIR")"
echo "   java       : $("$JAVA" -version 2>&1 | head -1)"
echo "=============================================="

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/classes" "$OUT_DIR/dex" "$APK_OUT"

# ---------------------------------------------------------- 1) Java
echo "▶ [1/6] 编译 Java 源码…"
find app/src -name '*.java' > "$OUT_DIR/sources.txt"
if ! "$JAVAC" -source 8 -target 8 -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
  -encoding UTF-8 -nowarn -d "$OUT_DIR/classes" @"$OUT_DIR/sources.txt" > "$OUT_DIR/javac.log" 2>&1; then
  echo "❌ Java 编译失败：" >&2
  cat "$OUT_DIR/javac.log" >&2
  exit 1
fi

COUNT=$(find "$OUT_DIR/classes" -name '*.class' | wc -l | tr -d ' ')
if [ "$COUNT" = "0" ]; then
  echo "❌ Java 编译失败" >&2
  exit 1
fi
echo "   ✅ $COUNT 个 class"

# ---------------------------------------------------------- 2) DEX
echo "▶ [2/6] 生成 classes.dex…"
find build/classes -name '*.class' > "$OUT_DIR/classes.txt"
"$JAVA" -cp "$D8_JAR" com.android.tools.r8.D8 \
  --lib "$ANDROID_JAR" --min-api 21 --release \
  --output "$OUT_DIR/dex" @"$OUT_DIR/classes.txt"
ls -lh "$OUT_DIR/dex/classes.dex" | awk '{print "   ✅ classes.dex "$5}'

# ---------------------------------------------------------- 3) 资源
echo "▶ [3/6] 编译资源…"
"$AAPT2" compile --dir "$APP_DIR/res" -o "$OUT_DIR/res.zip"

echo "▶ [4/6] 链接资源 + 打包 assets…"
"$AAPT2" link \
  -o "$OUT_DIR/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP_DIR/AndroidManifest.xml" \
  -A "$APP_DIR/assets" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay \
  "$OUT_DIR/res.zip"

# ------------------------------------------------------- 4) 合入 DEX
echo "▶ [5/6] 合入 dex 并对齐…"
python - "$OUT_DIR/base.apk" "$OUT_DIR/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('   ✅ classes.dex 已写入')
PY
"$ZIPALIGN" -f 4 "$OUT_DIR/base.apk" "$OUT_DIR/aligned.apk"

# ---------------------------------------------------------- 5) 签名
echo "▶ [6/6] 签名…"
KEYSTORE="$ROOT/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore "$KEYSTORE" -alias nodechat \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass android -keypass android \
    -dname "CN=Node Chat, OU=Demo, O=NodeChat, L=Shanghai, S=Shanghai, C=CN" >/dev/null 2>&1
fi

APK_NAME="node-chat-android.apk"
"$JAVA" -jar "$APKSIGNER_JAR" sign \
  --ks "$KEYSTORE" --ks-key-alias nodechat \
  --ks-pass pass:android --key-pass pass:android \
  --out "$APK_OUT/$APK_NAME" "$OUT_DIR/aligned.apk"

"$JAVA" -jar "$APKSIGNER_JAR" verify --print-certs "$APK_OUT/$APK_NAME" | head -4
echo ""
echo "✅ 构建完成: $APK_OUT/$APK_NAME"
ls -lh "$APK_OUT/$APK_NAME"
