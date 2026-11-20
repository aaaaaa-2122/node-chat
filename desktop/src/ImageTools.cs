using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace NodeChat
{
    /// <summary>图片压缩 / data URL 互转 / 缩略图缓存</summary>
    internal static class ImageTools
    {
        /// <summary>把本地图片压成 data URL，保证 base64 长度不超过 maxB64</summary>
        public static string ToDataUrl(string path, int maxDim, int maxB64)
        {
            byte[] raw = File.ReadAllBytes(path);
            using (MemoryStream ms = new MemoryStream(raw))
            using (Image src = Image.FromStream(ms))
            {
                int dim = maxDim;
                while (true)
                {
                    using (Bitmap bmp = Scale(src, dim, dim))
                    {
                        for (int q = 88; q >= 30; q -= 6)
                        {
                            byte[] jpeg = EncodeJpeg(bmp, q);
                            string b64 = Convert.ToBase64String(jpeg);
                            if (b64.Length <= maxB64) return "data:image/jpeg;base64," + b64;
                        }
                    }
                    if (dim <= 240) break;
                    dim = dim * 2 / 3;
                }
            }
            throw new InvalidOperationException("图片太大，压缩后仍超过上限，请换一张小一点的图");
        }

        public static Bitmap Scale(Image src, int maxW, int maxH)
        {
            double sw = src.Width;
            double sh = src.Height;
            double k = Math.Min(1.0, Math.Min(maxW / sw, maxH / sh));
            int w = Math.Max(1, (int)Math.Round(sw * k));
            int h = Math.Max(1, (int)Math.Round(sh * k));
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.Clear(Color.White);
                g.DrawImage(src, 0, 0, w, h);
            }
            return bmp;
        }

        public static byte[] EncodeJpeg(Bitmap bmp, int quality)
        {
            ImageCodecInfo codec = null;
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            {
                if (c.FormatID == ImageFormat.Jpeg.Guid) { codec = c; break; }
            }
            using (EncoderParameters ps = new EncoderParameters(1))
            {
                ps.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
                using (MemoryStream ms = new MemoryStream())
                {
                    bmp.Save(ms, codec, ps);
                    return ms.ToArray();
                }
            }
        }

        /// <summary>data URL → 缩放后的图片（失败返回 null）</summary>
        public static Image FromDataUrl(string url, int maxW, int maxH)
        {
            try
            {
                if (string.IsNullOrEmpty(url)) return null;
                int comma = url.IndexOf(',');
                if (comma < 0) return null;
                byte[] bytes = Convert.FromBase64String(url.Substring(comma + 1));
                using (MemoryStream ms = new MemoryStream(bytes))
                using (Image img = Image.FromStream(ms))
                {
                    return Scale(img, maxW, maxH);
                }
            }
            catch { return null; }
        }

        public static void SaveDataUrl(string url, string path)
        {
            int comma = url.IndexOf(',');
            if (comma < 0) throw new FormatException("不是有效的图片数据");
            byte[] bytes = Convert.FromBase64String(url.Substring(comma + 1));
            File.WriteAllBytes(path, bytes);
        }

        public static Image LoadCopy(string path)
        {
            byte[] raw = File.ReadAllBytes(path);
            using (MemoryStream ms = new MemoryStream(raw))
            using (Image img = Image.FromStream(ms))
            {
                return new Bitmap(img);
            }
        }

        /// <summary>按最长边缩放并居中裁成正方形（头像用）</summary>
        public static Bitmap Square(Image src, int size)
        {
            Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                double k = Math.Max((double)size / src.Width, (double)size / src.Height);
                int w = (int)Math.Ceiling(src.Width * k);
                int h = (int)Math.Ceiling(src.Height * k);
                g.DrawImage(src, new Rectangle((size - w) / 2, (size - h) / 2, w, h));
            }
            return bmp;
        }
    }

    /// <summary>
    /// 头像缓存：用户名 + data URL 指纹 -> 圆形位图。
    /// 避免每帧都解码 base64（消息多时会让滚动卡顿）。
    /// </summary>
    internal static class AvatarCache
    {
        private static readonly System.Collections.Generic.Dictionary<string, Image> cache =
            new System.Collections.Generic.Dictionary<string, Image>();
        private static readonly System.Collections.Generic.Dictionary<string, string> keys =
            new System.Collections.Generic.Dictionary<string, string>();

        public static Image Get(string user, string dataUrl, int size)
        {
            if (string.IsNullOrEmpty(user)) user = "?";
            string key = size + "|" + (dataUrl == null ? "" : dataUrl.Length + ":" + dataUrl.GetHashCode().ToString());
            string id = user + "@" + size;
            Image hit;
            if (cache.TryGetValue(id, out hit))
            {
                string old;
                if (keys.TryGetValue(id, out old) && old == key) return hit;
            }

            Image img = null;
            if (!string.IsNullOrEmpty(dataUrl))
            {
                Image raw = ImageTools.FromDataUrl(dataUrl, size * 2, size * 2);
                if (raw != null) img = ImageTools.Square(raw, size);
            }
            cache[id] = img;
            keys[id] = key;
            if (hit != null && !ReferenceEquals(hit, img)) { try { hit.Dispose(); } catch { } }
            return img;
        }
    }
}
