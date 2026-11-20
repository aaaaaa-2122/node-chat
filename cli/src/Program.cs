using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;

namespace NodeChat
{
    /// <summary>
    /// NodeChatCli — 与 node-chat / 桌面端 / 安卓端同一套协议的命令行客户端。
    /// 面向脚本与 agent：加 --json 后每条输出都是单行 JSON，退出码 0 成功 / 1 出错 / 2 用法错误。
    /// </summary>
    internal static class Program
    {
        private const string VERSION = "1.0.0";

        private sealed class Options
        {
            public string Host = "127.0.0.1";
            public int Port = Protocol.DEFAULT_PORT;
            public string User = "guest";
            public string Password = "123456";
            public bool Json;
            public int TimeoutMs = 10000;
            public int DurationSec = 15;
            public int Limit;
            public string Room;
            public string To;
            public string Image;
            public bool NoJoin;
            public readonly List<string> Positional = new List<string>();
        }

        private static Options _o = new Options();
        private static string _command = "";

        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            try
            {
                return Run(args);
            }
            catch (UsageException ex)
            {
                Fail("usage", ex.Message);
                return 2;
            }
            catch (ChatException ex)
            {
                Fail(ex.Code, ex.Message);
                return 1;
            }
            catch (TimeoutException ex)
            {
                Fail("timeout", ex.Message);
                return 1;
            }
            catch (ChatClosedException ex)
            {
                Fail("closed", ex.Message);
                return 1;
            }
            catch (Exception ex)
            {
                Fail("internal", ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        private static int Run(string[] argv)
        {
            if (argv.Length == 0) { Console.Write(Usage()); return 2; }

            Parse(argv);
            if (_o.Positional.Count == 0) { Console.Write(Usage()); return 2; }

            _command = _o.Positional[0].ToLowerInvariant();
            List<string> rest = _o.Positional.GetRange(1, _o.Positional.Count - 1);

            if (_command == "help") { Console.Write(Usage()); return 0; }

            using (ChatClient client = new ChatClient())
            {
                client.Connect(_o.Host, _o.Port, _o.TimeoutMs);
                Dictionary<string, object> auth = client.Auth(_o.User, _o.Password, _o.TimeoutMs);

                switch (_command)
                {
                    case "msg": return CmdMessage(client, rest, false);
                    case "group": return CmdMessage(client, rest, true);
                    case "send": return CmdSend(client, rest);
                    case "rooms": return CmdRooms(client);
                    case "members": return CmdMembers(client, rest);
                    case "who": return CmdWho(client);
                    case "history": return CmdHistory(client);
                    case "join": return CmdJoinLeave(client, true);
                    case "leave": return CmdJoinLeave(client, false);
                    case "ping": return CmdPing(client, auth);
                    case "listen": return CmdListen(client);
                    case "avatar": return CmdAvatarGet(client, rest);
                    case "set-avatar": return CmdAvatarSet(client, rest);
                    default:
                        throw new UsageException("未知命令: " + _command + "（用 --help 看用法）");
                }
            }
        }

        // ---------------------------------------------------------------- 命令

        private static int CmdMessage(ChatClient client, List<string> rest, bool toRoom)
        {
            string target;
            string text;
            if (toRoom)
            {
                target = rest.Count > 0 ? rest[0] : _o.Room;
                text = Join(rest, 1);
                if (string.IsNullOrEmpty(target)) throw new UsageException("用法: group <群名> <文本>");
            }
            else
            {
                target = rest.Count > 0 ? rest[0] : _o.To;
                text = Join(rest, 1);
                if (string.IsNullOrEmpty(target)) throw new UsageException("用法: msg <用户名> <文本>");
            }

            Dictionary<string, object> data = Protocol.Data("text", text);
            if (toRoom) data["room"] = target; else data["to"] = target;

            if (!string.IsNullOrEmpty(_o.Image))
                data["image"] = ImageTools.ToDataUrl(_o.Image, Protocol.MAX_IMAGE_LEN, 1280);

            if (toRoom && !_o.NoJoin)
            {
                try { client.Request(Protocol.JOIN, Protocol.Data("room", target), _o.TimeoutMs); }
                catch (ChatException) { /* 已在群里或无权，交给下面的发送报错 */ }
            }

            Dictionary<string, object> res = client.Request(
                toRoom ? Protocol.GROUP : Protocol.MSG, data, _o.TimeoutMs);

            Dictionary<string, object> message = Json.Obj(Get(res, "message"));

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["target"] = target;
                outObj["scope"] = toRoom ? "room" : "dm";
                outObj["message"] = message;
                if (res.ContainsKey("delivered")) outObj["delivered"] = Json.B(res, "delivered");
                Emit(outObj);
            }
            else if (toRoom)
            {
                Console.WriteLine("[群聊] " + target + " | " + _o.User + ": " + text);
                Console.WriteLine("✅ 群消息已发送到「" + target + "」");
            }
            else
            {
                bool delivered = !res.ContainsKey("delivered") || Json.B(res, "delivered");
                Console.WriteLine(delivered ? "✅ 私聊已发送给 " + target : "📮 对方离线，消息已存入信箱：" + target);
            }
            return 0;
        }

        private static int CmdSend(ChatClient client, List<string> rest)
        {
            string text = Join(rest, 0);
            if (!string.IsNullOrEmpty(_o.Room)) return CmdMessage(client, new List<string> { _o.Room, text }, true);
            if (!string.IsNullOrEmpty(_o.To)) return CmdMessage(client, new List<string> { _o.To, text }, false);
            throw new UsageException("send 需要 --to <用户名> 或 --room <群名>");
        }

        private static int CmdRooms(ChatClient client)
        {
            Dictionary<string, object> res = client.Request(Protocol.ROOMS, null, _o.TimeoutMs);
            List<object> rooms = Json.List(Get(res, "rooms")) ?? new List<object>();

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["rooms"] = rooms;
                outObj["count"] = rooms.Count;
                Emit(outObj);
                return 0;
            }
            if (rooms.Count == 0) { Console.WriteLine("（暂无群组）"); return 0; }
            foreach (object item in rooms)
            {
                Dictionary<string, object> r = Json.Obj(item);
                Console.WriteLine("• " + Json.S(r, "name") + "  成员 " + Json.N(r, "memberCount") + " 人");
            }
            return 0;
        }

        private static int CmdMembers(ChatClient client, List<string> rest)
        {
            string room = rest.Count > 0 ? rest[0] : _o.Room;
            if (string.IsNullOrEmpty(room)) throw new UsageException("用法: members --room <群名>");
            Dictionary<string, object> res = client.Request(Protocol.MEMBERS, Protocol.Data("room", room), _o.TimeoutMs);
            List<object> members = Json.List(Get(res, "members")) ?? new List<object>();

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["room"] = room;
                outObj["members"] = members;
                outObj["count"] = members.Count;
                outObj["exists"] = Json.B(res, "exists");
                Emit(outObj);
                return 0;
            }
            if (members.Count == 0) { Console.WriteLine("「" + room + "」暂无成员"); return 0; }
            Console.WriteLine("「" + room + "」成员（" + members.Count + "）：");
            foreach (object m in members) Console.WriteLine("  - " + Convert.ToString(m));
            return 0;
        }

        private static int CmdWho(ChatClient client)
        {
            Dictionary<string, object> res = client.Request(Protocol.WHO, null, _o.TimeoutMs);
            List<object> users = Json.List(Get(res, "users")) ?? new List<object>();

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["users"] = users;
                outObj["count"] = users.Count;
                Emit(outObj);
                return 0;
            }
            List<string> names = new List<string>();
            foreach (object u in users) names.Add(Convert.ToString(u));
            Console.WriteLine("在线用户（" + users.Count + "）：" + string.Join(", ", names.ToArray()));
            return 0;
        }

        private static int CmdHistory(ChatClient client)
        {
            Dictionary<string, object> data = new Dictionary<string, object>();
            if (!string.IsNullOrEmpty(_o.Room)) data["room"] = _o.Room;
            else if (!string.IsNullOrEmpty(_o.To)) data["to"] = _o.To;
            else throw new UsageException("history 需要 --room <群名> 或 --with <用户名>");
            if (_o.Limit > 0) data["limit"] = _o.Limit;

            Dictionary<string, object> res = client.Request(Protocol.HISTORY, data, _o.TimeoutMs);
            List<object> messages = Json.List(Get(res, "messages")) ?? new List<object>();

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["scope"] = Json.S(res, "scope");
                outObj["room"] = Json.S(res, "room");
                outObj["with"] = Json.S(res, "with");
                outObj["messages"] = messages;
                outObj["count"] = messages.Count;
                Emit(outObj);
                return 0;
            }
            if (messages.Count == 0) { Console.WriteLine("（暂无历史消息）"); return 0; }
            foreach (object item in messages)
            {
                Dictionary<string, object> m = Json.Obj(item);
                string body = Json.S(m, "text");
                if (string.IsNullOrEmpty(body) && m.ContainsKey("image")) body = "[图片]";
                Console.WriteLine("[" + FmtTime(Json.N(m, "ts")) + "] " + Json.S(m, "from") + ": " + body);
            }
            return 0;
        }

        private static int CmdJoinLeave(ChatClient client, bool join)
        {
            if (string.IsNullOrEmpty(_o.Room)) throw new UsageException((join ? "join" : "leave") + " 需要 --room <群名>");
            Dictionary<string, object> res = client.Request(
                join ? Protocol.JOIN : Protocol.LEAVE, Protocol.Data("room", _o.Room), _o.TimeoutMs);

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["room"] = _o.Room;
                outObj["joined"] = join;
                if (res.ContainsKey("created")) outObj["created"] = Json.B(res, "created");
                if (res.ContainsKey("members")) outObj["members"] = Json.List(Get(res, "members"));
                Emit(outObj);
                return 0;
            }
            if (join) Console.WriteLine("✅ 已加入群「" + _o.Room + "」" + (Json.B(res, "created") ? "（新建）" : ""));
            else Console.WriteLine("✅ 已退出群「" + _o.Room + "」");
            return 0;
        }

        private static int CmdPing(ChatClient client, Dictionary<string, object> auth)
        {
            DateTime start = DateTime.Now;
            client.Request(Protocol.PING, null, _o.TimeoutMs, Protocol.PONG);
            long ms = (long)(DateTime.Now - start).TotalMilliseconds;

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["pong"] = true;
                outObj["latencyMs"] = ms;
                outObj["user"] = client.Me;
                outObj["server"] = Json.S(auth, "server");
                outObj["rooms"] = (Json.List(Get(auth, "rooms")) ?? new List<object>()).Count;
                Emit(outObj);
                return 0;
            }
            Console.WriteLine("✅ pong " + ms + "ms · 已登录为 " + client.Me +
                              " · 服务端 " + (Json.S(auth, "server") ?? "?"));
            return 0;
        }

        private static int CmdListen(ChatClient client)
        {
            if (!_o.Json)
                Console.WriteLine("开始监听（" + _o.DurationSec + " 秒，Ctrl+C 可提前结束）…");

            DateTime deadline = DateTime.Now.AddSeconds(_o.DurationSec);
            while (DateTime.Now < deadline)
            {
                Dictionary<string, object> frame;
                try { frame = client.ReadFrame(1000); }
                catch (TimeoutException) { continue; }

                if (frame == null) continue;
                string type = Json.S(frame, "type");
                Dictionary<string, object> data = Json.Obj(Get(frame, "data")) ?? new Dictionary<string, object>();

                bool isMessage = type == Protocol.GROUP || type == Protocol.MSG;
                if (_o.Json)
                {
                    Dictionary<string, object> line = new Dictionary<string, object>();
                    line["event"] = isMessage ? "message" : (type == Protocol.SYSTEM ? "system" : type);
                    line["type"] = type;
                    line["data"] = data;
                    Emit(line);
                    continue;
                }

                if (isMessage)
                {
                    string body = Json.S(data, "text");
                    if (string.IsNullOrEmpty(body) && data.ContainsKey("image")) body = "[图片]";
                    string scope = type == Protocol.GROUP ? ("[群聊] " + Json.S(data, "room")) : "[私聊]";
                    Console.WriteLine("[" + FmtTime(Json.N(data, "ts")) + "] " +
                                      scope + " " + Json.S(data, "from") + ": " + body);
                }
                else if (type == Protocol.SYSTEM && Json.S(data, "event") == "announcement")
                {
                    Console.WriteLine("[公告] " + Json.S(data, "text"));
                }
            }
            return 0;
        }

        private static int CmdAvatarGet(ChatClient client, List<string> rest)
        {
            string user = rest.Count > 0 ? rest[0] : _o.User;
            Dictionary<string, object> res = client.Request(Protocol.PROFILE,
                Protocol.Data("action", "get", "user", user), _o.TimeoutMs);

            string avatar = Json.S(res, "avatar");
            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["user"] = user;
                outObj["hasAvatar"] = !string.IsNullOrEmpty(avatar);
                outObj["avatarLength"] = avatar == null ? 0 : avatar.Length;
                Emit(outObj);
                return 0;
            }
            Console.WriteLine(user + (string.IsNullOrEmpty(avatar)
                ? " 没有设置头像"
                : " 的头像：" + avatar.Substring(0, Math.Min(48, avatar.Length)) + "…（" + avatar.Length + " 字符）"));
            return 0;
        }

        private static int CmdAvatarSet(ChatClient client, List<string> rest)
        {
            string path = rest.Count > 0 ? rest[0] : null;
            if (string.IsNullOrEmpty(path)) throw new UsageException("用法: set-avatar <图片路径>");

            string dataUrl = ImageTools.ToDataUrl(path, Protocol.MAX_AVATAR_LEN, 160);
            Dictionary<string, object> res = client.Request(Protocol.PROFILE,
                Protocol.Data("action", "set", "avatar", dataUrl), _o.TimeoutMs);

            if (_o.Json)
            {
                Dictionary<string, object> outObj = Ok();
                outObj["user"] = Json.S(res, "user");
                outObj["avatarLength"] = dataUrl.Length;
                Emit(outObj);
                return 0;
            }
            Console.WriteLine("✅ 头像已更新（" + dataUrl.Length + " 字符）");
            return 0;
        }

        // ---------------------------------------------------------------- 工具

        private static void Parse(string[] argv)
        {
            for (int i = 0; i < argv.Length; i++)
            {
                string a = argv[i];
                switch (a)
                {
                    case "--host": _o.Host = Need(argv, ref i, a); break;
                    case "--port": _o.Port = Int(Need(argv, ref i, a), a); break;
                    case "--user": case "-u": _o.User = Need(argv, ref i, a); break;
                    case "--password": case "-k": _o.Password = Need(argv, ref i, a); break;
                    case "--room": _o.Room = Need(argv, ref i, a); break;
                    case "--to": case "--with": _o.To = Need(argv, ref i, a); break;
                    case "--image": _o.Image = Need(argv, ref i, a); break;
                    case "--limit": _o.Limit = Int(Need(argv, ref i, a), a); break;
                    case "--timeout": _o.TimeoutMs = Int(Need(argv, ref i, a), a); break;
                    case "--duration": _o.DurationSec = Int(Need(argv, ref i, a), a); break;
                    case "--json": _o.Json = true; break;
                    case "--no-join": _o.NoJoin = true; break;
                    case "--version": Console.WriteLine("NodeChatCli " + VERSION + " (协议 " + Protocol.VERSION + ")"); Environment.Exit(0); break;
                    case "--help": case "-h": case "-?": _o.Positional.Add("help"); break;
                    default:
                        if (a.StartsWith("-") && a.Length > 1) throw new UsageException("未知选项: " + a);
                        _o.Positional.Add(a);
                        break;
                }
            }
        }

        private static string Need(string[] argv, ref int i, string opt)
        {
            if (i + 1 >= argv.Length) throw new UsageException(opt + " 缺少参数值");
            return argv[++i];
        }

        private static int Int(string s, string opt)
        {
            int v;
            if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                throw new UsageException(opt + " 需要整数，收到: " + s);
            return v;
        }

        private static string Join(List<string> parts, int from)
        {
            if (parts.Count <= from) return "";
            return string.Join(" ", parts.GetRange(from, parts.Count - from).ToArray());
        }

        private static object Get(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        private static Dictionary<string, object> Ok()
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            o["ok"] = true;
            o["command"] = _command;
            return o;
        }

        private static void Emit(Dictionary<string, object> obj)
        {
            Console.WriteLine(Json.Stringify(obj));
        }

        private static void Fail(string code, string message)
        {
            if (_o != null && _o.Json)
            {
                Dictionary<string, object> o = new Dictionary<string, object>();
                o["ok"] = false;
                o["command"] = _command;
                o["error"] = Protocol.Data("code", code, "message", message);
                Console.WriteLine(Json.Stringify(o));
            }
            else
            {
                Console.Error.WriteLine("❌ " + message);
            }
        }

        private static string FmtTime(long ms)
        {
            if (ms <= 0) return "--:--";
            return new DateTime(1970, 1, 1).AddMilliseconds(ms).ToLocalTime().ToString("HH:mm");
        }

        private static string Usage()
        {
            return
@"NodeChatCli " + VERSION + @" — Node Chat 命令行客户端（协议 " + Protocol.VERSION + @"）

用法: NodeChatCli <命令> [参数] [选项]

命令:
  msg <用户> <文本>            私聊发送
  group <群名> <文本>          群消息（自动加入该群）
  send <文本>                  按 --to / --room 发送
  rooms                        列出所有群
  members [--room <群名>]      查看群成员
  who                          查看在线用户
  history --room <群> | --with <用户> [--limit N]
  join  --room <群名>          加入群
  leave --room <群名>          退出群
  listen [--duration <秒>]     持续接收消息（默认 15 秒）
  ping                         连通性 / 延迟检测
  avatar [用户名]              查询头像
  set-avatar <图片路径>         设置自己的头像

通用选项:
  --host <地址>          服务端地址（默认 127.0.0.1）
  --port <端口>          服务端端口（默认 " + Protocol.DEFAULT_PORT + @"）
  -u, --user <用户名>    用户名（默认 guest）
  -k, --password <密码>  密码（默认 123456）
  --json                 输出单行 JSON（便于脚本/agent 解析）
  --timeout <毫秒>       单次请求超时（默认 10000）
  --image <文件>         随消息附带图片（超过 600KB 自动缩放压缩）
  --no-join              发群消息时不自动加入
  --version / --help

示例:
  NodeChatCli --host <你的服务器IP> --port 9099 -u alice -k 123456 rooms
  NodeChatCli --host <你的服务器IP> -u alice -k 123456 group 大厅 ""大家好""
  NodeChatCli --host <你的服务器IP> -u alice -k 123456 --json listen --duration 30

退出码: 0 成功 / 1 出错 / 2 用法错误
";
        }
    }
}
