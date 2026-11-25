using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace NodeChat
{
    /// <summary>
    /// TCP 客户端：后台线程逐行读取（NDJSON），把原始行放进队列；
    /// 登录阶段由 ConnectAuth 自己消费队列，登录之后由界面定时器消费，
    /// 保证任何时刻只有一个消费者，不需要跨线程操作控件。
    /// </summary>
    internal sealed class ChatClient : IDisposable
    {
        private TcpClient tcp;
        private StreamReader reader;
        private StreamWriter writer;
        private readonly object gate = new object();
        private SecureChannel _channel; // 强制加密：握手后所有帧加解密
        private Thread readThread;

        public readonly ConcurrentQueue<string> Incoming = new ConcurrentQueue<string>();
        public volatile bool Alive;
        public string Host = "";
        public int Port;
        public string User = "";

        public const string ClosedSentinel = "\u0001";

        /// <summary>建立 TCP 连接并启动读线程（同步，应在后台线程调用）</summary>
        public void Open(string host, int port, int timeoutMs)
        {
            Close();
            while (Incoming.TryDequeue(out _)) { }

            tcp = new TcpClient();
            tcp.ReceiveTimeout = 0;
            IAsyncResult ar = tcp.BeginConnect(host, port, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(timeoutMs))
            {
                try { tcp.Close(); } catch { }
                throw new TimeoutException("连接超时：" + host + ":" + port);
            }
            tcp.EndConnect(ar);
            tcp.NoDelay = true;

            NetworkStream stream = tcp.GetStream();
            reader = new StreamReader(stream, new UTF8Encoding(false), false);
            writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.NewLine = "\n";
            writer.AutoFlush = true;

            // 强制加密：读线程启动前同步完成 secure 握手（握手帧明文）
            SecureHandshake(timeoutMs);

            Host = host;
            Port = port;
            Alive = true;

            readThread = new Thread(ReadLoop);
            readThread.IsBackground = true;
            readThread.Name = "node-chat-reader";
            readThread.Start();
        }

        /// <summary>强制加密：连接后同步做 secure 握手（读线程尚未启动）</summary>
        private void SecureHandshake(int timeoutMs)
        {
            byte[] priv, pub;
            CryptoPrimitives.GenerateX25519(out priv, out pub);
            string frame = Protocol.Frame(Protocol.SECURE,
                Protocol.Data("v", 1, "cpub", Convert.ToBase64String(pub)), null);
            lock (gate) { writer.WriteLine(frame); writer.Flush(); }

            string line = reader.ReadLine();
            if (line == null) throw new IOException("服务端在加密握手阶段关闭了连接");
            Dictionary<string, object> f = Json.Obj(Json.Parse(line));
            string type = Json.S(f, "type");
            Dictionary<string, object> data = Json.Obj(GetD(f, "data"));
            if (type == Protocol.SECURE_ERR)
                throw new IOException("加密握手被拒: " + (Json.S(data, "message") ?? "unknown"));
            if (type != Protocol.SECURE_OK)
                throw new IOException("加密握手应答异常: " + type);

            byte[] spub = Convert.FromBase64String(Json.S(data, "spub") ?? "");
            byte[] shared = CryptoPrimitives.X25519(priv, spub);
            byte[] salt = CryptoPrimitives.Sha256(Concat(pub, spub));
            byte[] c2s = CryptoPrimitives.HkdfSha256(shared, salt, Encoding.ASCII.GetBytes("nodechat-c2s"));
            byte[] s2c = CryptoPrimitives.HkdfSha256(shared, salt, Encoding.ASCII.GetBytes("nodechat-s2c"));
            _channel = new SecureChannel(c2s, s2c, 0);
        }
        private static object GetD(Dictionary<string, object> d, string key)
        {
            object v; return d != null && d.TryGetValue(key, out v) ? v : null;
        }
        private static byte[] Concat(byte[] a, byte[] b)
        {
            byte[] o = new byte[a.Length + b.Length];
            Array.Copy(a, o, a.Length); Array.Copy(b, 0, o, a.Length, b.Length);
            return o;
        }
        private void ReadLoop()
        {
            try
            {
                while (true)
                {
                    string line = reader.ReadLine();
                    if (line == null) break;
                    if (line.Length == 0) continue;
                    Incoming.Enqueue(_channel == null ? line : _channel.Open(line));
                }
            }
            catch { }
            Alive = false;
            Incoming.Enqueue(ClosedSentinel);
        }

        public void Send(string type, Dictionary<string, object> data)
        {
            Send(type, data, null);
        }

        public void Send(string type, Dictionary<string, object> data, string id)
        {
            string line = Protocol.Frame(type, data, id);
            lock (gate)
            {
                if (writer == null) throw new InvalidOperationException("连接已断开");
                writer.WriteLine(_channel == null ? line : _channel.Seal(line));
                writer.Flush();
            }
        }

        /// <summary>
        /// 连接 + 认证。返回 auth_ok 的 data；失败抛异常（message 可直接展示给用户）。
        /// 认证期间收到的其它帧（welcome / presence）会保留在队列里交给界面处理。
        /// </summary>
        public static ChatClient ConnectAuth(string host, int port, string user, string password, int timeoutMs, out Dictionary<string, object> authData)
        {
            ChatClient c = new ChatClient();
            c.Open(host, port, timeoutMs);
            c.User = user;
            c.Send(Protocol.AUTH, Protocol.Data("username", user, "password", password));

            List<string> keep = new List<string>();
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                string line;
                if (!c.Incoming.TryDequeue(out line))
                {
                    if (!c.Alive) throw new IOException("连接被服务端关闭");
                    Thread.Sleep(15);
                    continue;
                }
                if (line == ChatClient.ClosedSentinel) throw new IOException("连接被服务端关闭");

                Dictionary<string, object> frame = null;
                try { frame = Json.Obj(Json.Parse(line)); } catch { continue; }
                string type = Json.S(frame, "type");
                Dictionary<string, object> data = Json.Obj(frame.ContainsKey("data") ? frame["data"] : null);

                if (type == Protocol.AUTH_OK)
                {
                    authData = data ?? new Dictionary<string, object>();
                    // 把登录期间收到的非认证帧放回队列
                    for (int i = 0; i < keep.Count; i++) c.Incoming.Enqueue(keep[i]);
                    return c;
                }
                if (type == Protocol.AUTH_ERR)
                {
                    c.Close();
                    string msg = Json.S(data, "message");
                    throw new UnauthorizedAccessException(msg.Length > 0 ? msg : "认证失败");
                }
                keep.Add(line);
            }
            c.Close();
            throw new TimeoutException("认证超时，请检查服务器地址与端口");
        }

        /// <summary>注册：发邮箱验证码。失败抛异常；成功返回 register_ok 的 data</summary>
        public static Dictionary<string, object> Register(string host, int port, string user, string password, string email, int timeoutMs)
        {
            using (ChatClient c = new ChatClient())
            {
                c.Open(host, port, timeoutMs);
                c.Send(Protocol.REGISTER, Protocol.Data("username", user, "password", password, "email", email));
                return WaitReply(c, Protocol.REGISTER_ERR, timeoutMs);
            }
        }

        /// <summary>提交邮箱验证码。成功则已登录（返回 auth_ok 的 data）</summary>
        public static Dictionary<string, object> VerifyEmail(string host, int port, string user, string code, int timeoutMs)
        {
            using (ChatClient c = new ChatClient())
            {
                c.Open(host, port, timeoutMs);
                c.Send(Protocol.VERIFY_EMAIL, Protocol.Data("username", user, "code", code));
                Dictionary<string, object> data = WaitReply(c, Protocol.VERIFY_ERR, timeoutMs);
                c.User = user;
                return data;
            }
        }

        /// <summary>重发验证码</summary>
        public static Dictionary<string, object> ResendCode(string host, int port, string user, int timeoutMs)
        {
            using (ChatClient c = new ChatClient())
            {
                c.Open(host, port, timeoutMs);
                c.Send(Protocol.RESEND_CODE, Protocol.Data("username", user));
                return WaitReply(c, Protocol.VERIFY_ERR, timeoutMs);
            }
        }

        /// <summary>读一帧直到匹配目标类型；遇 errType 抛异常。返回该帧的 data</summary>
        private static Dictionary<string, object> WaitReply(ChatClient c, string errType, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                string line;
                if (!c.Incoming.TryDequeue(out line))
                {
                    if (!c.Alive) throw new IOException("连接被服务端关闭");
                    Thread.Sleep(15);
                    continue;
                }
                if (line == ChatClient.ClosedSentinel) throw new IOException("连接被服务端关闭");
                Dictionary<string, object> frame = null;
                try { frame = Json.Obj(Json.Parse(line)); } catch { continue; }
                string type = Json.S(frame, "type");
                Dictionary<string, object> data = Json.Obj(frame.ContainsKey("data") ? frame["data"] : null);
                if (type == errType)
                {
                    c.Close();
                    string msg = Json.S(data, "message");
                    throw new UnauthorizedAccessException(msg.Length > 0 ? msg : "请求失败");
                }
                if (type == Protocol.AUTH_OK || type == Protocol.REGISTER_OK || type == Protocol.VERIFY_OK)
                    return data ?? new Dictionary<string, object>();
            }
            c.Close();
            throw new TimeoutException("请求超时");
        }

        public void Close()
        {
            Alive = false;
            try { if (writer != null) writer.Write("{\"type\":\"quit\",\"data\":{}}\n"); } catch { }
            try { if (writer != null) writer.Flush(); } catch { }
            try { if (tcp != null) tcp.Client.Shutdown(SocketShutdown.Both); } catch { }
            try { if (tcp != null) tcp.Close(); } catch { }
            lock (gate) { writer = null; reader = null; tcp = null; }
        }

        public void Dispose() { Close(); }
    }
}
