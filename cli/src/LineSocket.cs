using System;
using System.Diagnostics;
using System.Net.Sockets;
using System.Text;

namespace NodeChat
{
    /// <summary>连接被服务端关闭</summary>
    internal sealed class ChatClosedException : Exception
    {
        public ChatClosedException(string message) : base(message) { }
    }

    /// <summary>服务端返回 error 帧</summary>
    internal sealed class ChatException : Exception
    {
        public string Code { get; private set; }
        public ChatException(string code, string message) : base(message) { Code = code ?? "error"; }
    }

    /// <summary>用法错误（退出码 2）</summary>
    internal sealed class UsageException : Exception
    {
        public UsageException(string message) : base(message) { }
    }

    /// <summary>
    /// 按行读写的 TCP 连接（UTF-8，NDJSON）。带超时，可在阻塞式命令行里安全使用。
    /// </summary>
    internal sealed class LineSocket : IDisposable
    {
        private readonly Socket _socket;
        private byte[] _buf = new byte[16 * 1024];
        private int _len;

        public LineSocket(string host, int port, int connectTimeoutMs)
        {
            _socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            _socket.NoDelay = true;
            try
            {
                IAsyncResult ar = _socket.BeginConnect(host, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(connectTimeoutMs))
                    throw new TimeoutException("连接 " + host + ":" + port + " 超时");
                _socket.EndConnect(ar);
            }
            catch (SocketException ex)
            {
                throw new ChatException("connect_failed",
                    "连接 " + host + ":" + port + " 失败：" + ex.Message);
            }
        }

        public void WriteLine(string line)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
            int sent = 0;
            while (sent < bytes.Length)
            {
                sent += _socket.Send(bytes, sent, bytes.Length - sent, SocketFlags.None);
            }
        }

        /// <summary>读一行；超时抛 TimeoutException，对端关闭返回 null</summary>
        public string ReadLine(int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (true)
            {
                for (int i = 0; i < _len; i++)
                {
                    if (_buf[i] != (byte)'\n') continue;
                    string line = Encoding.UTF8.GetString(_buf, 0, i);
                    int rest = _len - i - 1;
                    Buffer.BlockCopy(_buf, i + 1, _buf, 0, rest);
                    _len = rest;
                    return line.TrimEnd('\r');
                }

                if (_len == _buf.Length) Array.Resize(ref _buf, _buf.Length * 2);

                int remaining;
                if (timeoutMs <= 0) remaining = 0;
                else
                {
                    remaining = timeoutMs - (int)sw.ElapsedMilliseconds;
                    if (remaining <= 0) throw new TimeoutException("等待服务端响应超时（" + timeoutMs + "ms）");
                }
                _socket.ReceiveTimeout = remaining;

                int n;
                try
                {
                    n = _socket.Receive(_buf, _len, _buf.Length - _len, SocketFlags.None);
                }
                catch (SocketException ex)
                {
                    if (ex.SocketErrorCode == SocketError.TimedOut)
                        throw new TimeoutException("等待服务端响应超时（" + timeoutMs + "ms）");
                    throw new ChatClosedException("连接中断：" + ex.Message);
                }
                if (n <= 0) return null;
                _len += n;
            }
        }

        public void Dispose()
        {
            try { _socket.Shutdown(SocketShutdown.Both); } catch { }
            try { _socket.Close(); } catch { }
        }
    }
}
