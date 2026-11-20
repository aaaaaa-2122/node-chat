using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace NodeChat
{
    /// <summary>一条「登录过的服务器」记录</summary>
    internal sealed class ServerEntry
    {
        public string Host = "";
        public int Port = Protocol.DEFAULT_PORT;
        public string User = "";
        public long Last;

        public string Key
        {
            get { return Host + ":" + Port.ToString(CultureInfo.InvariantCulture); }
        }

        public bool IsLocal
        {
            get { return Host == "127.0.0.1" || Host == "localhost" || Host == "::1"; }
        }

        public string Display
        {
            get
            {
                string s = Key;
                if (User.Length > 0) s += "    ·    " + User;
                return s;
            }
        }

        public string When
        {
            get
            {
                if (Last <= 0) return "";
                DateTime t = new DateTime(Last, DateTimeKind.Utc).ToLocalTime();
                if (t.Date == DateTime.Today) return t.ToString("HH:mm");
                if (t.Date == DateTime.Today.AddDays(-1)) return "昨天";
                return t.ToString("MM-dd");
            }
        }
    }

    /// <summary>
    /// 记住登录过的服务端：%APPDATA%\NodeChat\servers.json
    /// 只保存地址与用户名，不保存密码。
    /// </summary>
    internal sealed class ServerStore
    {
        private const int MaxKeep = 12;

        public readonly List<ServerEntry> Entries = new List<ServerEntry>();

        public static string Dir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "NodeChat"); }
        }

        public static string FilePath { get { return Path.Combine(Dir, "servers.json"); } }

        public void Load()
        {
            Entries.Clear();
            try
            {
                if (!File.Exists(FilePath)) return;
                List<object> list = Json.List(Json.Parse(File.ReadAllText(FilePath, Encoding.UTF8)));
                if (list == null) return;
                foreach (object o in list)
                {
                    Dictionary<string, object> d = Json.Obj(o);
                    if (d == null) continue;
                    ServerEntry e = new ServerEntry();
                    e.Host = Json.S(d, "host").Trim();
                    e.Port = (int)Json.N(d, "port");
                    e.User = Json.S(d, "user");
                    e.Last = Json.N(d, "last");
                    if (e.Host.Length == 0 || e.Port <= 0 || e.Port > 65535) continue;
                    Entries.Add(e);
                }
                Sort();
            }
            catch { }
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(Dir);
                List<object> list = new List<object>();
                foreach (ServerEntry e in Entries)
                {
                    Dictionary<string, object> d = new Dictionary<string, object>();
                    d["host"] = e.Host;
                    d["port"] = e.Port;
                    d["user"] = e.User;
                    d["last"] = e.Last;
                    list.Add(d);
                }
                File.WriteAllText(FilePath, Json.Stringify(list), new UTF8Encoding(false));
            }
            catch { }
        }

        private void Sort()
        {
            Entries.Sort(delegate (ServerEntry a, ServerEntry b) { return b.Last.CompareTo(a.Last); });
        }

        /// <summary>登录成功后记住该服务端（host:port 去重，最近使用排最前）</summary>
        public void Remember(string host, int port, string user)
        {
            string key = host + ":" + port.ToString(CultureInfo.InvariantCulture);
            ServerEntry hit = null;
            foreach (ServerEntry e in Entries)
            {
                if (string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase)) { hit = e; break; }
            }
            if (hit == null)
            {
                hit = new ServerEntry();
                hit.Host = host;
                hit.Port = port;
                Entries.Add(hit);
            }
            hit.User = user;
            hit.Last = DateTime.UtcNow.Ticks;
            Sort();
            while (Entries.Count > MaxKeep) Entries.RemoveAt(Entries.Count - 1);
            Save();
        }

        public void Forget(string key)
        {
            for (int i = Entries.Count - 1; i >= 0; i--)
            {
                if (string.Equals(Entries[i].Key, key, StringComparison.OrdinalIgnoreCase)) Entries.RemoveAt(i);
            }
            Save();
        }

        public ServerEntry Find(string key)
        {
            foreach (ServerEntry e in Entries)
            {
                if (string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase)) return e;
            }
            return null;
        }
    }

    /// <summary>窗口尺寸等界面偏好：settings.json</summary>
    internal sealed class Prefs
    {
        public int Width = 1120;
        public int Height = 740;
        public bool Maximized;
        public string LastRoom = "";
        public string LastHost = "";
        public string LastPort = "";
        public string LastUser = "";
        public bool RememberServer = true;

        public static string FilePath { get { return Path.Combine(ServerStore.Dir, "settings.json"); } }

        public static Prefs Load()
        {
            Prefs p = new Prefs();
            try
            {
                if (!File.Exists(FilePath)) return p;
                Dictionary<string, object> d = Json.Obj(Json.Parse(File.ReadAllText(FilePath, Encoding.UTF8)));
                if (d == null) return p;
                int w = (int)Json.N(d, "width");
                int h = (int)Json.N(d, "height");
                if (w >= 900 && w <= 6000) p.Width = w;
                if (h >= 560 && h <= 4000) p.Height = h;
                p.Maximized = Json.B(d, "maximized");
                p.LastRoom = Json.S(d, "lastRoom");
                p.LastHost = Json.S(d, "lastHost");
                p.LastPort = Json.S(d, "lastPort");
                p.LastUser = Json.S(d, "lastUser");
                p.RememberServer = !d.ContainsKey("rememberServer") || Json.B(d, "rememberServer");
            }
            catch { }
            return p;
        }

        public void Save()
        {
            try
            {
                Directory.CreateDirectory(ServerStore.Dir);
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["width"] = Width;
                d["height"] = Height;
                d["maximized"] = Maximized;
                d["lastRoom"] = LastRoom ?? "";
                d["lastHost"] = LastHost ?? "";
                d["lastPort"] = LastPort ?? "";
                d["lastUser"] = LastUser ?? "";
                d["rememberServer"] = RememberServer;
                File.WriteAllText(FilePath, Json.Stringify(d), new UTF8Encoding(false));
            }
            catch { }
        }
    }
}
