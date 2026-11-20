package com.nodechat.mobile;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 零依赖 JSON 编解码器（不依赖 org.json，保证核心代码可在桌面 JVM 上运行与测试）。
 * 支持对象、数组、字符串（含 Unicode 转义）、数字、布尔、null。
 */
public final class Json {

    private Json() {}

    // ------------------------------------------------------------- 序列化
    public static String stringify(Object value) {
        StringBuilder sb = new StringBuilder();
        write(value, sb);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(Object v, StringBuilder sb) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString((String) v, sb);
        } else if (v instanceof Boolean) {
            sb.append(v.toString());
        } else if (v instanceof Number) {
            writeNumber((Number) v, sb);
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(e.getKey() == null ? "null" : e.getKey(), sb);
                sb.append(':');
                write(e.getValue(), sb);
            }
            sb.append('}');
        } else if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object o : (Iterable<Object>) v) {
                if (!first) sb.append(',');
                first = false;
                write(o, sb);
            }
            sb.append(']');
        } else if (v instanceof Object[]) {
            write(java.util.Arrays.asList((Object[]) v), sb);
        } else {
            writeString(v.toString(), sb);
        }
    }

    private static void writeNumber(Number n, StringBuilder sb) {
        double d = n.doubleValue();
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            sb.append("null");
            return;
        }
        if (n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte) {
            sb.append(n.longValue());
        } else {
            // 去掉多余的 .0，保持和 JS Number 一致的观感
            if (d == Math.floor(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                sb.append((long) d);
            } else {
                sb.append(d);
            }
        }
    }

    private static void writeString(String s, StringBuilder sb) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20 || c == '\u2028' || c == '\u2029') {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // --------------------------------------------------------------- 解析
    public static Object parse(String text) {
        if (text == null) throw new IllegalArgumentException("json 为空");
        Parser p = new Parser(text);
        p.skipWhitespace();
        Object v = p.parseValue();
        p.skipWhitespace();
        if (!p.atEnd()) throw new IllegalArgumentException("json 结尾有多余内容 @" + p.pos);
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object v = parse(text);
        if (!(v instanceof Map)) throw new IllegalArgumentException("不是 JSON 对象");
        return (Map<String, Object>) v;
    }

    private static final class Parser {
        private final String s;
        private int pos;

        Parser(String s) {
            this.s = s;
        }

        boolean atEnd() {
            return pos >= s.length();
        }

        void skipWhitespace() {
            while (pos < s.length()) {
                char c = s.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
                else break;
            }
        }

        Object parseValue() {
            skipWhitespace();
            if (atEnd()) throw new IllegalArgumentException("json 意外结束");
            char c = s.charAt(pos);
            switch (c) {
                case '{': return parseObjectValue();
                case '[': return parseArray();
                case '"': return parseString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return parseNumber();
            }
        }

        private void expect(String literal) {
            if (!s.startsWith(literal, pos)) {
                throw new IllegalArgumentException("json 非法字面量 @" + pos);
            }
            pos += literal.length();
        }

        private Map<String, Object> parseObjectValue() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // {
            skipWhitespace();
            if (!atEnd() && s.charAt(pos) == '}') {
                pos++;
                return map;
            }
            while (true) {
                skipWhitespace();
                if (atEnd() || s.charAt(pos) != '"') {
                    throw new IllegalArgumentException("json 对象键非法 @" + pos);
                }
                String key = parseString();
                skipWhitespace();
                if (atEnd() || s.charAt(pos) != ':') {
                    throw new IllegalArgumentException("json 缺少冒号 @" + pos);
                }
                pos++;
                map.put(key, parseValue());
                skipWhitespace();
                if (atEnd()) throw new IllegalArgumentException("json 对象未闭合");
                char c = s.charAt(pos);
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == '}') {
                    pos++;
                    return map;
                }
                throw new IllegalArgumentException("json 对象分隔符非法 @" + pos);
            }
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            pos++; // [
            skipWhitespace();
            if (!atEnd() && s.charAt(pos) == ']') {
                pos++;
                return list;
            }
            while (true) {
                list.add(parseValue());
                skipWhitespace();
                if (atEnd()) throw new IllegalArgumentException("json 数组未闭合");
                char c = s.charAt(pos);
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == ']') {
                    pos++;
                    return list;
                }
                throw new IllegalArgumentException("json 数组分隔符非法 @" + pos);
            }
        }

        private String parseString() {
            StringBuilder sb = new StringBuilder();
            pos++; // opening quote
            while (true) {
                if (atEnd()) throw new IllegalArgumentException("json 字符串未闭合");
                char c = s.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (atEnd()) throw new IllegalArgumentException("json 转义未完成");
                    char e = s.charAt(pos++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (pos + 4 > s.length()) throw new IllegalArgumentException("json \\u 转义非法");
                            sb.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
                            pos += 4;
                            break;
                        default:
                            throw new IllegalArgumentException("json 转义字符非法: " + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        private Object parseNumber() {
            int start = pos;
            if (!atEnd() && (s.charAt(pos) == '-' || s.charAt(pos) == '+')) pos++;
            boolean dot = false;
            boolean exp = false;
            while (!atEnd()) {
                char c = s.charAt(pos);
                if (c >= '0' && c <= '9') {
                    pos++;
                } else if (c == '.' && !dot && !exp) {
                    dot = true;
                    pos++;
                } else if ((c == 'e' || c == 'E') && !exp) {
                    exp = true;
                    pos++;
                    if (!atEnd() && (s.charAt(pos) == '-' || s.charAt(pos) == '+')) pos++;
                } else {
                    break;
                }
            }
            if (start == pos) throw new IllegalArgumentException("json 数字非法 @" + pos);
            String num = s.substring(start, pos);
            if (!dot && !exp) {
                try {
                    return Long.parseLong(num);
                } catch (NumberFormatException ignored) {
                    // 超出 long 范围，退化为 double
                }
            }
            return Double.parseDouble(num);
        }
    }

    // ------------------------------------------------------------- 工具方法
    public static Map<String, Object> obj() {
        return new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> asArray(Object v) {
        return v instanceof List ? (List<Object>) v : null;
    }

    public static String getStr(Map<String, Object> map, String key) {
        return getStr(map, key, null);
    }

    public static String getStr(Map<String, Object> map, String key, String def) {
        if (map == null) return def;
        Object v = map.get(key);
        return v instanceof String ? (String) v : def;
    }

    public static long getLong(Map<String, Object> map, String key, long def) {
        if (map == null) return def;
        Object v = map.get(key);
        if (v instanceof Number) return ((Number) v).longValue();
        if (v instanceof String) {
            try {
                return Long.parseLong((String) v);
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    public static int getInt(Map<String, Object> map, String key, int def) {
        return (int) getLong(map, key, def);
    }

    public static boolean getBool(Map<String, Object> map, String key, boolean def) {
        if (map == null) return def;
        Object v = map.get(key);
        return v instanceof Boolean ? (Boolean) v : def;
    }

    public static Map<String, Object> getMap(Map<String, Object> map, String key) {
        if (map == null) return null;
        return asObject(map.get(key));
    }
}
