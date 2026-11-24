using System;
using System.Collections.Generic;

namespace NodeChat
{
    /// <summary>
    /// 协议常量：TCP + NDJSON，与 node-chat / 安卓端完全一致。
    /// </summary>
    internal static class Protocol
    {
        public const string VERSION = "1.0";

        // 客户端 -> 服务端
        public const string AUTH = "auth";
        public const string REGISTER = "register";
        public const string VERIFY_EMAIL = "verify_email";
        public const string RESEND_CODE = "resend_code";
        public const string MSG = "msg";
        public const string GROUP = "group";
        public const string JOIN = "join";
        public const string LEAVE = "leave";
        public const string ROOMS = "rooms";
        public const string MEMBERS = "members";
        public const string WHO = "who";
        public const string HISTORY = "history";
        public const string PROFILE = "profile";
        public const string PING = "ping";
        public const string QUIT = "quit";

        // 服务端 -> 客户端
        public const string AUTH_OK = "auth_ok";
        public const string AUTH_ERR = "auth_err";
        public const string REGISTER_OK = "register_ok";
        public const string REGISTER_ERR = "register_err";
        public const string VERIFY_OK = "verify_ok";
        public const string VERIFY_ERR = "verify_err";
        public const string JOIN_OK = "join_ok";
        public const string LEAVE_OK = "leave_ok";
        public const string ACK = "ack";
        public const string ERROR = "error";
        public const string PONG = "pong";
        public const string SYSTEM = "system";
        public const string PRESENCE = "presence";

        public const int MAX_TEXT = 4000;
        public const int MAX_IMAGE_LEN = 600 * 1000;   // 单张图片 data URL 上限
        public const int MAX_AVATAR_LEN = 100 * 1000;  // 头像 data URL 上限
        public const int DEFAULT_PORT = 9099;

        public static string Frame(string type, Dictionary<string, object> data, string id)
        {
            Dictionary<string, object> frame = new Dictionary<string, object>();
            frame["type"] = type;
            frame["data"] = data == null ? new Dictionary<string, object>() : data;
            if (!string.IsNullOrEmpty(id)) frame["id"] = id;
            return Json.Stringify(frame);
        }

        public static Dictionary<string, object> Data(params object[] kv)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2)
            {
                d[Convert.ToString(kv[i])] = kv[i + 1];
            }
            return d;
        }
    }
}
