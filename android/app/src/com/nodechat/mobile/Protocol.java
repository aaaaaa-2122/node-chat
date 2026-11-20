package com.nodechat.mobile;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 协议定义（与 Node 版 node-chat 完全一致：NDJSON over TCP）。
 *
 * 每一帧是一行 JSON：{"type":"...","id":"可选","data":{...}}
 */
public final class Protocol {

    private Protocol() {}

    public static final String VERSION = "1.0";

    // 客户端 -> 服务端
    public static final String C2S_AUTH = "auth";
    public static final String C2S_MSG = "msg";
    public static final String C2S_GROUP = "group";
    public static final String C2S_JOIN = "join";
    public static final String C2S_LEAVE = "leave";
    public static final String C2S_ROOMS = "rooms";
    public static final String C2S_MEMBERS = "members";
    public static final String C2S_WHO = "who";
    public static final String C2S_HISTORY = "history";
    public static final String C2S_PROFILE = "profile";
    public static final String C2S_PING = "ping";
    public static final String C2S_QUIT = "quit";

    // 服务端 -> 客户端
    public static final String S2C_AUTH_OK = "auth_ok";
    public static final String S2C_AUTH_ERR = "auth_err";
    public static final String S2C_MSG = "msg";
    public static final String S2C_GROUP = "group";
    public static final String S2C_JOIN_OK = "join_ok";
    public static final String S2C_LEAVE_OK = "leave_ok";
    public static final String S2C_ROOMS = "rooms";
    public static final String S2C_MEMBERS = "members";
    public static final String S2C_WHO = "who";
    public static final String S2C_HISTORY = "history";
    public static final String S2C_PROFILE = "profile";
    public static final String S2C_ACK = "ack";
    public static final String S2C_ERROR = "error";
    public static final String S2C_PONG = "pong";
    public static final String S2C_SYSTEM = "system";
    public static final String S2C_PRESENCE = "presence";

    // 错误码
    public static final String ERR_UNAUTHORIZED = "unauthorized";
    public static final String ERR_BAD_REQUEST = "bad_request";
    public static final String ERR_NOT_FOUND = "not_found";
    public static final String ERR_NOT_IN_ROOM = "not_in_room";
    public static final String ERR_RATE_LIMIT = "rate_limit";
    public static final String ERR_INTERNAL = "internal";

    // 限制
    public static final int MAX_LINE = 1024 * 1024; // 单帧最大长度（图片以 data URL 内联）
    public static final int MAX_TEXT = 4000;
    public static final int MAX_ROOM_NAME = 32;
    public static final int MAX_USERNAME = 24;
    public static final int MAX_HISTORY = 200;
    public static final int HISTORY_KEEP = 500;
    public static final int MAX_IMAGE_LEN = 600 * 1000;   // 单张图片（data URL）最大长度
    public static final int MAX_AVATAR_LEN = 100 * 1000;  // 头像（data URL）最大长度
    public static final int IMAGE_HISTORY_KEEP = 50;      // 历史中保留图片的条数

    private static final Pattern USERNAME_RE = Pattern.compile("^[A-Za-z0-9_\\u4e00-\\u9fa5.\\-]{1,24}$");
    private static final Pattern ROOMNAME_RE = Pattern.compile("^[A-Za-z0-9_\\u4e00-\\u9fa5.\\-]{1,32}$");

    public static boolean isValidUsername(String name) {
        return name != null && USERNAME_RE.matcher(name).matches();
    }

    public static boolean isValidRoomName(String name) {
        return name != null && ROOMNAME_RE.matcher(name).matches();
    }

    public static boolean isValidText(String text) {
        return text != null && !text.isEmpty() && text.length() <= MAX_TEXT;
    }

    /** 图片必须是 data:image/...;base64,... 形式 */
    public static boolean isValidImageDataUrl(String value) {
        return value != null && value.startsWith("data:image/") && value.length() <= MAX_IMAGE_LEN;
    }

    /** 头像同样是 data URL，但体积上限更小 */
    public static boolean isValidAvatarDataUrl(String value) {
        return value != null && value.startsWith("data:image/") && value.length() <= MAX_AVATAR_LEN;
    }

    /** 两人会话的稳定 key（与顺序无关） */
    public static String dmKey(String a, String b) {
        return a.compareTo(b) <= 0 ? a + b : b + a;
    }

    /** 构造一帧（不含换行） */
    public static String frame(String type, Map<String, Object> data, String id) {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("type", type);
        envelope.put("data", data == null ? Json.obj() : data);
        if (id != null && !id.isEmpty()) envelope.put("id", id);
        return Json.stringify(envelope);
    }

    public static String frame(String type, Map<String, Object> data) {
        return frame(type, data, null);
    }

    /** 把 JSON 文本转义成合法的 JS 字符串字面量（用于 evaluateJavascript 注入） */
    public static String jsStringLiteral(String raw) {
        StringBuilder sb = new StringBuilder(raw.length() + 16);
        sb.append('"');
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
