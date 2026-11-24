using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace NodeChat
{
    /// <summary>与服务端的一条会话：认证 + 请求/响应 + 被动收帧</summary>
    internal sealed class ChatClient : IDisposable
    {
        private LineSocket _sock;
        private int _seq;

        public string Me { get; private set; }
        public Dictionary<string, object> AuthData { get; private set; }

        public void Connect(string host, int port, int connectTimeoutMs)
        {
            _sock = new LineSocket(host, port, connectTimeoutMs);
        }

        /// <summary>认证；失败抛 ChatException</summary>
        public Dictionary<string, object> Auth(string user, string password, int timeoutMs)
        {
            _sock.WriteLine(Protocol.Frame(Protocol.AUTH,
                Protocol.Data("username", user, "password", password), "auth"));

            while (true)
            {
                string line = _sock.ReadLine(timeoutMs);
                if (line == null) throw new ChatClosedException("服务端关闭了连接（认证阶段）");
                Dictionary<string, object> f = AsFrame(line);
                if (f == null) continue;
                string type = Json.S(f, "type");
                Dictionary<string, object> data = Json.Obj(Get(f, "data"));

                if (type == Protocol.AUTH_ERR)
                    throw new ChatException("auth_failed", Json.S(data, "message") ?? "认证失败");
                if (type == Protocol.AUTH_OK)
                {
                    Me = Json.S(data, "user");
                    AuthData = data;
                    return data;
                }
                // system / presence 等非认证帧忽略
            }
        }

        /// <summary>注册（发邮箱验证码）；成功抛异常则失败</summary>
        public Dictionary<string, object> Register(string user, string password, string email, int timeoutMs)
        {
            _sock.WriteLine(Protocol.Frame(Protocol.REGISTER,
                Protocol.Data("username", user, "password", password, "email", email), "reg"));
            while (true)
            {
                string line = _sock.ReadLine(timeoutMs);
                if (line == null) throw new ChatClosedException("服务端关闭了连接（注册阶段）");
                Dictionary<string, object> f = AsFrame(line);
                if (f == null) continue;
                string type = Json.S(f, "type");
                Dictionary<string, object> data = Json.Obj(Get(f, "data"));
                if (type == Protocol.REGISTER_ERR)
                    throw new ChatException("register_failed", Json.S(data, "message") ?? "注册失败");
                if (type == Protocol.REGISTER_OK) return data;
            }
        }

        /// <summary>提交邮箱验证码；成功则已登录（返回 auth 数据）</summary>
        public Dictionary<string, object> VerifyEmail(string user, string code, int timeoutMs)
        {
            _sock.WriteLine(Protocol.Frame(Protocol.VERIFY_EMAIL,
                Protocol.Data("username", user, "code", code), "verify"));
            while (true)
            {
                string line = _sock.ReadLine(timeoutMs);
                if (line == null) throw new ChatClosedException("服务端关闭了连接（验证阶段）");
                Dictionary<string, object> f = AsFrame(line);
                if (f == null) continue;
                string type = Json.S(f, "type");
                Dictionary<string, object> data = Json.Obj(Get(f, "data"));
                if (type == Protocol.VERIFY_ERR)
                    throw new ChatException("verify_failed", Json.S(data, "message") ?? "验证失败");
                if (type == Protocol.AUTH_OK)
                {
                    Me = Json.S(data, "user");
                    AuthData = data;
                    return data;
                }
                if (type == Protocol.VERIFY_OK && Json.B(data, "resent")) return data; // 重发回执
            }
        }

        /// <summary>重发验证码</summary>
        public Dictionary<string, object> ResendCode(string user, int timeoutMs)
        {
            _sock.WriteLine(Protocol.Frame(Protocol.RESEND_CODE,
                Protocol.Data("username", user), "resend"));
            while (true)
            {
                string line = _sock.ReadLine(timeoutMs);
                if (line == null) throw new ChatClosedException("服务端关闭了连接（重发阶段）");
                Dictionary<string, object> f = AsFrame(line);
                if (f == null) continue;
                string type = Json.S(f, "type");
                Dictionary<string, object> data = Json.Obj(Get(f, "data"));
                if (type == Protocol.VERIFY_ERR)
                    throw new ChatException("resend_failed", Json.S(data, "message") ?? "重发失败");
                if (type == Protocol.VERIFY_OK) return data;
            }
        }

        /// <summary>
        /// 发一条请求并等待响应。
        /// 默认按 id 匹配；个别帧（如 pong）服务端不带 id，可传 expectType 按类型匹配。
        /// </summary>
        public Dictionary<string, object> Request(string type, Dictionary<string, object> data, int timeoutMs,
                                                  string expectType = null)
        {
            string id = "c" + (++_seq) + "_" + DateTime.Now.Ticks.ToString("x");
            _sock.WriteLine(Protocol.Frame(type, data, id));

            while (true)
            {
                string line = _sock.ReadLine(timeoutMs);
                if (line == null) throw new ChatClosedException("服务端关闭了连接");
                Dictionary<string, object> f = AsFrame(line);
                if (f == null) continue;

                string frameType = Json.S(f, "type");
                bool matched = !string.IsNullOrEmpty(expectType)
                    ? string.Equals(frameType, expectType, StringComparison.Ordinal)
                    : string.Equals(Json.S(f, "id"), id, StringComparison.Ordinal);
                if (!matched) continue;

                Dictionary<string, object> payload = Json.Obj(Get(f, "data")) ?? new Dictionary<string, object>();
                if (frameType == Protocol.ERROR)
                    throw new ChatException(Json.S(payload, "code"), Json.S(payload, "message") ?? "服务端返回错误");
                return payload;
            }
        }

        /// <summary>只发不收（join/leave/ping 之类不关心结果时用）</summary>
        public void Send(string type, Dictionary<string, object> data)
        {
            _sock.WriteLine(Protocol.Frame(type, data, null));
        }

        /// <summary>读一帧；超时返回 null，连接关闭抛异常</summary>
        public Dictionary<string, object> ReadFrame(int timeoutMs)
        {
            string line = _sock.ReadLine(timeoutMs);
            if (line == null) throw new ChatClosedException("服务端关闭了连接");
            return AsFrame(line);
        }

        public void Dispose()
        {
            try { Send(Protocol.QUIT, null); } catch { }
            if (_sock != null) _sock.Dispose();
        }

        private static object Get(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        private static Dictionary<string, object> AsFrame(string line)
        {
            if (string.IsNullOrEmpty(line)) return null;
            try { return Json.Obj(Json.Parse(line)); }
            catch { return null; }
        }
    }

    /// <summary>图片转 data URL：小图直传，大图自动缩放 + JPEG 压缩</summary>
    internal static class ImageTools
    {
        public static string ToDataUrl(string path, int maxLen, int maxDim)
        {
            if (!File.Exists(path)) throw new UsageException("图片文件不存在：" + path);
            byte[] raw = File.ReadAllBytes(path);
            string direct = "data:" + MimeOf(path) + ";base64," + Convert.ToBase64String(raw);
            if (direct.Length <= maxLen) return direct;

            using (Image img = Image.FromFile(path))
            {
                int dim = maxDim;
                for (int round = 0; round < 6; round++)
                {
                    using (Bitmap scaled = Resize(img, dim))
                    {
                        foreach (int quality in new[] { 82, 72, 62, 50 })
                        {
                            string url = "data:image/jpeg;base64," +
                                         Convert.ToBase64String(EncodeJpeg(scaled, quality));
                            if (url.Length <= maxLen) return url;
                        }
                    }
                    dim = Math.Max(96, dim * 3 / 4);
                }
            }
            throw new ChatException("image_too_large",
                "图片压到最小仍超过 " + maxLen + " 字符，请换一张小一点的图");
        }

        private static string MimeOf(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".bmp": return "image/bmp";
                default: return "image/png";
            }
        }

        private static Bitmap Resize(Image src, int maxDim)
        {
            double scale = Math.Min(1.0, (double)maxDim / Math.Max(src.Width, src.Height));
            int w = Math.Max(1, (int)Math.Round(src.Width * scale));
            int h = Math.Max(1, (int)Math.Round(src.Height * scale));
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.White);
                g.DrawImage(src, 0, 0, w, h);
            }
            return bmp;
        }

        private static byte[] EncodeJpeg(Bitmap bmp, int quality)
        {
            ImageCodecInfo jpeg = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            {
                if (c.FormatID == ImageFormat.Jpeg.Guid) { jpeg = c; break; }
            }
            using (EncoderParameters p = new EncoderParameters(1))
            {
                p.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
                using (MemoryStream ms = new MemoryStream())
                {
                    if (jpeg != null) bmp.Save(ms, jpeg, p);
                    else bmp.Save(ms, ImageFormat.Jpeg);
                    return ms.ToArray();
                }
            }
        }
    }
}
