using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;

namespace NodeChat
{
    /// <summary>
    /// 通用文件上传：把文件按 4MB 分块 POST 到网页网关的 /upload，拿到 /files/xxx 引用。
    /// 局域网版把「发图片/视频」统一成「发文件」，文件本体走 HTTP，不进聊天帧，
    /// 所以大小和格式都不受 NDJSON 单帧上限的约束。
    /// </summary>
    internal static class FileUpload
    {
        private const int ChunkSize = 4 * 1024 * 1024; // 与网关 MAX_CHUNK_SIZE 一致
        public const int DefaultGatewayPort = 8080;

        public static Dictionary<string, object> Upload(string host, int gatewayPort, string filePath, int timeoutMs)
        {
            if (string.IsNullOrEmpty(filePath)) throw new UsageException("--file 需要文件路径");
            if (!File.Exists(filePath)) throw new ChatException("file_not_found", "文件不存在: " + filePath);

            FileInfo fi = new FileInfo(filePath);
            long size = fi.Length;
            int total = (int)Math.Max(1, (size + ChunkSize - 1) / ChunkSize);
            string uploadId = Guid.NewGuid().ToString("N");
            string finalUrl = null;

            using (FileStream fs = File.OpenRead(filePath))
            {
                byte[] buf = new byte[ChunkSize];
                for (int i = 0; i < total; i++)
                {
                    long left = size - (long)i * ChunkSize;
                    int want = (int)Math.Min(ChunkSize, left);
                    int read = 0;
                    while (read < want)
                    {
                        int n = fs.Read(buf, read, want - read);
                        if (n <= 0) break;
                        read += n;
                    }

                    string query = string.Format(
                        "?name={0}&mime={1}&uploadId={2}&chunk={3}&total={4}",
                        Uri.EscapeDataString(fi.Name), Uri.EscapeDataString(MimeOf(fi.Extension)),
                        uploadId, i, total);
                    string endpoint = string.Format("http://{0}:{1}/upload{2}", host, gatewayPort, query);

                    string body = Post(endpoint, buf, read, timeoutMs);
                    Dictionary<string, object> json = Json.Obj(Json.Parse(body));
                    if (json == null) throw new ChatException("upload_failed", "文件服务返回了非法响应");
                    if (Json.B(json, "ok") == false)
                    {
                        string msg = Json.S(json, "message") ?? Json.S(json, "error") ?? "上传失败";
                        throw new ChatException("upload_failed", msg);
                    }
                    string u = Json.S(json, "url");
                    if (!string.IsNullOrEmpty(u)) finalUrl = u;
                }
            }

            if (string.IsNullOrEmpty(finalUrl)) throw new ChatException("upload_failed", "上传未完成");

            Dictionary<string, object> file = new Dictionary<string, object>();
            file["url"] = finalUrl;
            file["name"] = fi.Name;
            file["size"] = (long)fi.Length;
            file["mime"] = MimeOf(fi.Extension);
            return file;
        }

        private static string Post(string endpoint, byte[] buf, int count, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint);
            req.Method = "POST";
            req.ContentType = "application/octet-stream";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = Math.Max(timeoutMs, 60000);
            req.KeepAlive = false;
            req.ContentLength = count;
            try
            {
                using (Stream s = req.GetRequestStream())
                {
                    s.Write(buf, 0, count);
                }
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (Stream rs = res.GetResponseStream())
                using (StreamReader reader = new StreamReader(rs, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                // 4xx 也会走到这里，把响应体读出来给用户看（比如「不允许上传该类型」）
                HttpWebResponse res = ex.Response as HttpWebResponse;
                if (res != null)
                {
                    using (Stream rs = res.GetResponseStream())
                    using (StreamReader reader = new StreamReader(rs, Encoding.UTF8))
                    {
                        string text = reader.ReadToEnd();
                        if (!string.IsNullOrEmpty(text)) return text;
                    }
                }
                throw new ChatException("upload_failed",
                    "连不上文件服务（" + endpoint + "）：该服务器可能没开网页网关（默认 8080 端口）");
            }
        }

        /// <summary>只用于 Content-Type 提示，网关会以扩展名为准做安全判断</summary>
        public static string MimeOf(string ext)
        {
            switch ((ext ?? "").ToLowerInvariant())
            {
                case ".png": return "image/png";
                case ".jpg":
                case ".jpeg": return "image/jpeg";
                case ".gif": return "image/gif";
                case ".webp": return "image/webp";
                case ".bmp": return "image/bmp";
                case ".mp4": return "video/mp4";
                case ".webm": return "video/webm";
                case ".mov": return "video/quicktime";
                case ".mp3": return "audio/mpeg";
                case ".wav": return "audio/wav";
                case ".pdf": return "application/pdf";
                case ".txt":
                case ".log":
                case ".md": return "text/plain";
                case ".json": return "application/json";
                case ".zip": return "application/zip";
                default: return "application/octet-stream";
            }
        }
    }
}
