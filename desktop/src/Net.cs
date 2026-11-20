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

            Host = host;
            Port = port;
            Alive = true;

            readThread = new Thread(ReadLoop);
            readThread.IsBackground = true;
            readThread.Name = "node-chat-reader";
            readThread.Start();
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
                    Incoming.Enqueue(line);
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
                writer.WriteLine(line);
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
