using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Media;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace NodeChat
{
    internal sealed class RoomInfo
    {
        public string Name = "";
        public int Members;
    }

    internal sealed class Conversation
    {
        public string Key = "";
        public string Name = "";
        public bool IsRoom;
        public string Preview = "";
        public long LastTs;
        public int Unread;
        public readonly List<ChatMessage> Messages = new List<ChatMessage>();
    }

    /// <summary>
    /// 主界面：左侧群聊/私聊列表，中间消息流与输入区，右侧成员/在线列表。
    /// 全部自绘，鼠标可完成所有操作（选会话、发消息、发图、换头像、看大图）。
    /// </summary>
    internal sealed class MainForm : Form
    {
        private ChatClient client;
        private readonly string password;
        private readonly Prefs prefs;
        private readonly string host;
        private readonly int port;
        private string me = "";
        private string serverName = "";
        private string currentKey = "";
        private bool rightVisible = true;
        private bool rightShowsMembers = true;
        private bool disconnectHandled;

        private readonly List<RoomInfo> rooms = new List<RoomInfo>();
        private readonly Dictionary<string, Conversation> convs = new Dictionary<string, Conversation>();
        private readonly Dictionary<string, string> avatars = new Dictionary<string, string>();
        private readonly HashSet<string> online = new HashSet<string>();
        private readonly HashSet<string> members = new HashSet<string>();
        private readonly HashSet<string> avatarRequested = new HashSet<string>();
        private readonly HashSet<string> joined = new HashSet<string>();

        private string myAvatar = "";
        private string pendingImage = null;
        private string pendingImageName = "";

        // 控件
        private Panel sidebar;
        private Panel brandBar;
        private SideList convList;
        private AvatarBox myAvatarBox;
        private Label meLabel;
        private Label statusLabel;
        private FlatButton logoutButton;

        private Panel header;
        private MessageView messages;
        private Label headerTitle;
        private Label headerSub;
        private FlatButton membersButton;
        private FlatButton refreshButton;
        private FlatButton reconnectButton;

        private Panel composer;
        private Panel attachPanel;
        private PictureBox attachThumb;
        private Label attachName;
        private FlatButton attachRemove;
        private FlatButton attachButton;
        private TextField input;
        private FlatButton sendButton;
        private Label hintLabel;

        private Panel rightPanel;
        private SideList rightList;

        private ToastBox toast;
        private readonly Timer pump = new Timer();
        private long lastWho;
        private bool whoQueued;

        public MainForm(ChatClient client, string host, int port, string password, Prefs prefs, Dictionary<string, object> auth)
        {
            this.client = client;
            this.host = host;
            this.port = port;
            this.password = password;
            this.prefs = prefs;
            this.me = Json.S(auth, "user");
            this.serverName = Json.S(auth, "server");
            this.myAvatar = Json.S(auth, "avatar");
            SeedRooms(auth);

            Text = "Node Chat";
            BackColor = Theme.Bg;
            Font = Ui.F(9f);
            AutoScaleMode = AutoScaleMode.None;
            MinimumSize = new Size(Ui.S(880), Ui.S(580));
            StartPosition = FormStartPosition.CenterScreen;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int wantW = Math.Min(Ui.S(prefs.Width), wa.Width - Ui.S(40));
            int wantH = Math.Min(Ui.S(prefs.Height), wa.Height - Ui.S(40));
            Size = new Size(Math.Max(Ui.S(820), wantW), Math.Max(Ui.S(540), wantH));
            if (prefs.Maximized) WindowState = FormWindowState.Maximized;
            DoubleBuffered = true;
            KeyPreview = true;
            AllowDrop = true;

            BuildSidebar();
            BuildHeader();
            BuildMessages();
            BuildComposer();
            BuildRight();

            toast = new ToastBox();
            Controls.Add(toast);

            if (!string.IsNullOrEmpty(myAvatar)) avatars[me] = myAvatar;

            pump.Interval = 120;
            pump.Tick += delegate { PumpFrames(); };
            pump.Start();

            Load += delegate
            {
                RebuildSidebar();
                LayoutChildren();
                LoadInitial();
            };
            FormClosing += delegate
            {
                pump.Stop();
                try { prefs.Width = WindowState == FormWindowState.Normal ? Width : RestoreBounds.Width; } catch { }
                try { prefs.Height = WindowState == FormWindowState.Normal ? Height : RestoreBounds.Height; } catch { }
                prefs.Maximized = WindowState == FormWindowState.Maximized;
                prefs.LastRoom = currentKey;
                prefs.Save();
            };
            FormClosed += delegate { try { client.Close(); } catch { } };
        }

        // ================================================================ UI 构建
        private void BuildSidebar()
        {
            sidebar = new Panel();
            sidebar.BackColor = Theme.Sidebar;
            sidebar.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border))
                {
                    e.Graphics.DrawLine(p, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
                }
            };
            Controls.Add(sidebar);

            brandBar = new Panel();
            brandBar.BackColor = Theme.Sidebar;
            brandBar.Paint += PaintBrand;
            sidebar.Controls.Add(brandBar);

            convList = new SideList();
            convList.ItemClick += delegate (object s, SideItem item) { OnSideItem(item); };
            sidebar.Controls.Add(convList);

            myAvatarBox = new AvatarBox();
            myAvatarBox.User = me;
            myAvatarBox.DataUrl = myAvatar;
            myAvatarBox.Cursor = Cursors.Hand;
            myAvatarBox.Click += delegate { ShowProfileMenu(); };
            sidebar.Controls.Add(myAvatarBox);

            meLabel = new Label();
            meLabel.AutoSize = false;
            meLabel.Text = me;
            meLabel.ForeColor = Theme.Text;
            meLabel.Font = Ui.F(9.5f, true);
            meLabel.BackColor = Color.Transparent;
            meLabel.Cursor = Cursors.Hand;
            meLabel.Click += delegate { ShowProfileMenu(); };
            sidebar.Controls.Add(meLabel);

            statusLabel = new Label();
            statusLabel.AutoSize = false;
            statusLabel.Text = "在线";
            statusLabel.ForeColor = Theme.Muted;
            statusLabel.Font = Ui.F(8f);
            statusLabel.BackColor = Color.Transparent;
            sidebar.Controls.Add(statusLabel);

            logoutButton = new FlatButton();
            logoutButton.Text = "退出";
            logoutButton.Kind = ButtonKind.Ghost;
            logoutButton.Font = Ui.F(8.5f);
            logoutButton.Click += delegate { Logout(); };
            sidebar.Controls.Add(logoutButton);
        }

        private void PaintBrand(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.Sidebar);

            Rectangle logo = new Rectangle(Ui.S(18), Ui.S(17), Ui.S(30), Ui.S(30));
            Ui.FillRound(g, logo, Ui.S(9), Theme.Accent);
            TextRenderer.DrawText(g, "N", Ui.F(12f, true), logo, Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);

            TextRenderer.DrawText(g, "Node Chat", Ui.F(11f, true),
                new Rectangle(Ui.S(56), Ui.S(15), sidebar.Width - Ui.S(70), Ui.S(20)), Theme.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

            string sub = host + ":" + port;
            TextRenderer.DrawText(g, sub, Ui.F(7.8f),
                new Rectangle(Ui.S(57), Ui.S(33), sidebar.Width - Ui.S(72), Ui.S(16)), Theme.Faint,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

            using (Pen p = new Pen(Theme.Divider))
            {
                g.DrawLine(p, Ui.S(16), brandBar.Height - 1, sidebar.Width - Ui.S(16), brandBar.Height - 1);
            }
        }

        private void BuildHeader()
        {
            header = new Panel();
            header.BackColor = Theme.Surface;
            header.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border))
                {
                    e.Graphics.DrawLine(p, 0, header.Height - 1, header.Width, header.Height - 1);
                }
            };
            Controls.Add(header);

            headerTitle = new Label();
            headerTitle.AutoSize = false;
            headerTitle.Font = Ui.F(12.5f, true);
            headerTitle.ForeColor = Theme.Text;
            headerTitle.BackColor = Color.Transparent;
            header.Controls.Add(headerTitle);

            headerSub = new Label();
            headerSub.AutoSize = false;
            headerSub.Font = Ui.F(8.2f);
            headerSub.ForeColor = Theme.Muted;
            headerSub.BackColor = Color.Transparent;
            header.Controls.Add(headerSub);

            membersButton = new FlatButton();
            membersButton.Text = "成员";
            membersButton.Kind = ButtonKind.Ghost;
            membersButton.Font = Ui.F(8.5f);
            membersButton.Click += delegate
            {
                rightVisible = !rightVisible;
                if (rightVisible) rightShowsMembers = true;
                LayoutChildren();
                RefreshRightPanel();
            };
            header.Controls.Add(membersButton);

            refreshButton = new FlatButton();
            refreshButton.Text = "刷新";
            refreshButton.Kind = ButtonKind.Ghost;
            refreshButton.Font = Ui.F(8.5f);
            refreshButton.Click += delegate
            {
                RefreshWho();
                if (IsRoom(currentKey)) RefreshMembers(RoomOf(currentKey));
                LoadHistory(currentKey, true);
                toast.Show("已刷新");
            };
            header.Controls.Add(refreshButton);

            reconnectButton = new FlatButton();
            reconnectButton.Text = "重新连接";
            reconnectButton.Kind = ButtonKind.Primary;
            reconnectButton.Font = Ui.F(8.5f);
            reconnectButton.Visible = false;
            reconnectButton.Click += delegate { Reconnect(); };
            header.Controls.Add(reconnectButton);
        }

        private void BuildMessages()
        {
            messages = new MessageView();
            messages.Me = me;
            messages.AvatarUrl = delegate (string u) { return AvatarOf(u); };
            messages.ImageActivated += delegate (object s, string url) { ShowImage(url); };
            messages.AvatarActivated += delegate (object s, string user) { OpenDm(user); };
            messages.AllowDrop = true;
            messages.DragEnter += OnDragEnter;
            messages.DragDrop += OnDragDrop;
            Controls.Add(messages);
        }

        private void BuildComposer()
        {
            composer = new Panel();
            composer.BackColor = Theme.Surface;
            composer.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border))
                {
                    e.Graphics.DrawLine(p, 0, 0, composer.Width, 0);
                }
            };
            composer.AllowDrop = true;
            composer.DragEnter += OnDragEnter;
            composer.DragDrop += OnDragDrop;
            Controls.Add(composer);

            attachPanel = new Panel();
            attachPanel.BackColor = Color.FromArgb(247, 249, 253);
            attachPanel.Visible = false;
            attachPanel.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Ui.StrokeRound(e.Graphics, new Rectangle(0, 0, attachPanel.Width - 1, attachPanel.Height - 1), Ui.S(8), Theme.Border, 1f);
            };
            composer.Controls.Add(attachPanel);

            attachThumb = new PictureBox();
            attachThumb.SizeMode = PictureBoxSizeMode.Zoom;
            attachThumb.BackColor = Color.White;
            attachPanel.Controls.Add(attachThumb);

            attachName = new Label();
            attachName.AutoSize = false;
            attachName.ForeColor = Theme.Muted;
            attachName.Font = Ui.F(8.5f);
            attachName.BackColor = Color.Transparent;
            attachPanel.Controls.Add(attachName);

            attachRemove = new FlatButton();
            attachRemove.Text = "移除";
            attachRemove.Kind = ButtonKind.Link;
            attachRemove.Font = Ui.F(8.5f);
            attachRemove.Click += delegate { ClearAttachment(); };
            attachPanel.Controls.Add(attachRemove);

            attachButton = new FlatButton();
            attachButton.Text = "图片";
            attachButton.Kind = ButtonKind.Soft;
            attachButton.Font = Ui.F(9f);
            attachButton.Click += delegate { PickImage(); };
            composer.Controls.Add(attachButton);

            input = new TextField(true);
            input.SetPlaceholder("输入消息，Enter 发送，Shift+Enter 换行");
            input.Box.ScrollBars = ScrollBars.None;
            input.Box.KeyDown += InputKeyDown;
            input.Box.TextChanged += delegate { UpdateCharCount(); };
            input.AllowDrop = true;
            input.DragEnter += OnDragEnter;
            input.DragDrop += OnDragDrop;
            composer.Controls.Add(input);

            sendButton = new FlatButton();
            sendButton.Text = "发送";
            sendButton.Kind = ButtonKind.Primary;
            sendButton.Font = Ui.F(9.5f, true);
            sendButton.Click += delegate { SendCurrent(); };
            composer.Controls.Add(sendButton);

            hintLabel = new Label();
            hintLabel.AutoSize = false;
            hintLabel.Text = "";
            hintLabel.ForeColor = Theme.Faint;
            hintLabel.Font = Ui.F(7.8f);
            hintLabel.BackColor = Color.Transparent;
            hintLabel.TextAlign = ContentAlignment.MiddleRight;
            composer.Controls.Add(hintLabel);
            UpdateCharCount();
        }

        private void BuildRight()
        {
            rightPanel = new Panel();
            rightPanel.BackColor = Theme.Surface;
            rightPanel.Paint += delegate (object s, PaintEventArgs e)
            {
                using (Pen p = new Pen(Theme.Border))
                {
                    e.Graphics.DrawLine(p, 0, 0, 0, rightPanel.Height);
                }
            };
            Controls.Add(rightPanel);

            rightList = new SideList();
            rightList.BackColor = Theme.Surface;
            rightList.ItemClick += delegate (object s, SideItem item)
            {
                int p = item.Key.IndexOf(':');
                string who = p > 0 ? item.Key.Substring(p + 1) : item.Key;
                if (who.Length > 0 && who != me) OpenDm(who);
            };
            rightPanel.Controls.Add(rightList);
        }

        // ================================================================ 布局
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            LayoutChildren();
        }

        private void LayoutChildren()
        {
            if (sidebar == null) return;
            SuspendLayout();
            int sw = Ui.S(268);
            int rh = rightVisible ? Ui.S(244) : 0;

            sidebar.SetBounds(0, 0, sw, ClientSize.Height);
            brandBar.SetBounds(0, 0, sw, Ui.S(62));
            convList.SetBounds(0, Ui.S(62), sw - 1, Math.Max(0, ClientSize.Height - Ui.S(62) - Ui.S(78)));

            myAvatarBox.SetBounds(Ui.S(18), ClientSize.Height - Ui.S(62), Ui.S(34), Ui.S(34));
            meLabel.SetBounds(Ui.S(62), ClientSize.Height - Ui.S(62), Ui.S(120), Ui.S(20));
            statusLabel.SetBounds(Ui.S(62), ClientSize.Height - Ui.S(40), Ui.S(150), Ui.S(18));
            logoutButton.SetBounds(sw - Ui.S(62), ClientSize.Height - Ui.S(54), Ui.S(46), Ui.S(28));

            int cx = sw;
            int cw = Math.Max(Ui.S(320), ClientSize.Width - sw - rh);
            header.SetBounds(cx, 0, cw, Ui.S(66));
            headerTitle.SetBounds(Ui.S(24), Ui.S(12), cw - Ui.S(300), Ui.S(26));
            headerSub.SetBounds(Ui.S(25), Ui.S(38), cw - Ui.S(300), Ui.S(18));

            int bx = cw - Ui.S(14);
            reconnectButton.SetBounds(bx - Ui.S(88), Ui.S(18), Ui.S(88), Ui.S(30));
            if (reconnectButton.Visible) bx -= Ui.S(96);
            refreshButton.SetBounds(bx - Ui.S(50), Ui.S(18), Ui.S(50), Ui.S(30));
            membersButton.SetBounds(bx - Ui.S(104), Ui.S(18), Ui.S(50), Ui.S(30));

            int composerH = Ui.S(100) + (attachPanel.Visible ? Ui.S(76) : 0);
            int msgTop = Ui.S(66);
            int msgH = Math.Max(Ui.S(120), ClientSize.Height - msgTop - composerH);
            messages.SetBounds(cx, msgTop, cw, msgH);
            composer.SetBounds(cx, msgTop + msgH, cw, composerH);

            int innerX = Ui.S(20);
            int innerW = cw - Ui.S(40);
            if (attachPanel.Visible)
            {
                attachPanel.SetBounds(innerX, Ui.S(12), innerW, Ui.S(64));
                attachThumb.SetBounds(Ui.S(6), Ui.S(6), Ui.S(84), Ui.S(52));
                attachName.SetBounds(Ui.S(100), Ui.S(14), Math.Max(Ui.S(60), innerW - Ui.S(220)), Ui.S(20));
                attachRemove.SetBounds(innerW - Ui.S(60), Ui.S(20), Ui.S(50), Ui.S(24));
            }

            int inputY = Ui.S(14) + (attachPanel.Visible ? Ui.S(76) : 0);
            attachButton.SetBounds(innerX, inputY + Ui.S(8), Ui.S(52), Ui.S(40));
            sendButton.SetBounds(innerX + innerW - Ui.S(78), inputY + Ui.S(8), Ui.S(78), Ui.S(40));
            input.SetBounds(innerX + Ui.S(62), inputY, Math.Max(Ui.S(120), innerW - Ui.S(62) - Ui.S(90)), Ui.S(56));
            hintLabel.SetBounds(innerX + innerW - Ui.S(420), inputY + Ui.S(60), Ui.S(400), Ui.S(16));

            if (rightVisible)
            {
                rightPanel.SetBounds(ClientSize.Width - rh, 0, rh, ClientSize.Height);
                rightList.SetBounds(0, Ui.S(8), rh - 1, ClientSize.Height - Ui.S(8));
                rightPanel.Visible = true;
            }
            else
            {
                rightPanel.Visible = false;
            }

            toast.SetBounds(
                ClientSize.Width - toast.Width - Ui.S(28),
                ClientSize.Height - toast.Height - Ui.S(28),
                toast.Width, toast.Height);
            ResumeLayout();
        }

        private void UpdateCharCount()
        {
            string t = input.Value;
            int n = t.Trim().Length == 0 ? 0 : t.Length;
            hintLabel.Text = n > 0 ? n + " / " + Protocol.MAX_TEXT + "　·　Enter 发送" : "Enter 发送　·　Shift+Enter 换行";
            hintLabel.ForeColor = n > Protocol.MAX_TEXT ? Theme.Red : Theme.Faint;
            sendButton.Enabled = n <= Protocol.MAX_TEXT;
        }

        // ============================================================ 会话与列表
        private static bool IsRoom(string key) { return key != null && key.StartsWith("room:"); }
        private static string RoomOf(string key) { return key.Substring(5); }
        private static string DmOf(string key) { return key.Substring(3); }

        private void RebuildSidebar()
        {
            List<SideItem> items = new List<SideItem>();

            SideItem gh = new SideItem();
            gh.Kind = "header";
            gh.Title = "群聊";
            gh.Right = rooms.Count.ToString();
            items.Add(gh);

            SideItem create = new SideItem();
            create.Kind = "action";
            create.Key = "action:newroom";
            create.Title = "新建群聊";
            items.Add(create);

            foreach (RoomInfo r in rooms)
            {
                Conversation c;
                convs.TryGetValue("room:" + r.Name, out c);
                SideItem it = new SideItem();
                it.Kind = "room";
                it.Key = "room:" + r.Name;
                it.Title = r.Name;
                it.Sub = c != null && c.Preview.Length > 0 ? c.Preview : (r.Members > 0 ? r.Members + " 位成员" : "暂无消息");
                it.Badge = c != null ? c.Unread : 0;
                it.AvatarUser = "#" + r.Name;
                items.Add(it);
            }

            SideItem dh = new SideItem();
            dh.Kind = "header";
            dh.Title = "私聊";
            int dmCount = 0;
            foreach (Conversation c in convs.Values) if (!c.IsRoom) dmCount++;
            dh.Right = dmCount > 0 ? dmCount.ToString() : "";
            items.Add(dh);

            List<Conversation> dms = new List<Conversation>();
            foreach (Conversation c in convs.Values) if (!c.IsRoom) dms.Add(c);
            dms.Sort(delegate (Conversation a, Conversation b) { return b.LastTs.CompareTo(a.LastTs); });
            foreach (Conversation c in dms)
            {
                SideItem it = new SideItem();
                it.Kind = "dm";
                it.Key = c.Key;
                it.Title = c.Name;
                it.Sub = c.Preview;
                it.Badge = c.Unread;
                it.Online = online.Contains(c.Name);
                it.AvatarUser = c.Name;
                it.AvatarUrl = AvatarOf(c.Name);
                items.Add(it);
            }
            if (dms.Count == 0)
            {
                SideItem hint = new SideItem();
                hint.Kind = "hint";
                hint.Title = "点右侧在线用户开始私聊";
                items.Add(hint);
            }

            convList.SelectedKey = currentKey;
            convList.SetItems(items);
        }

        private void RefreshRightPanel()
        {
            if (rightList == null) return;
            List<SideItem> items = new List<SideItem>();

            SideItem h1 = new SideItem();
            h1.Kind = "header";
            h1.Title = "在线用户";
            h1.Right = online.Count.ToString();
            items.Add(h1);

            List<string> users = new List<string>(online);
            users.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (string u in users)
            {
                SideItem it = new SideItem();
                it.Kind = "dm";
                it.Key = "user:" + u;
                it.Title = u + (u == me ? "（我）" : "");
                it.Sub = u == me ? "这是你" : "点击发私聊";
                it.Online = true;
                it.Self = u == me;
                it.AvatarUser = u;
                it.AvatarUrl = AvatarOf(u);
                items.Add(it);
            }
            if (users.Count == 0)
            {
                SideItem hint = new SideItem();
                hint.Kind = "hint";
                hint.Title = "暂无其他在线用户";
                items.Add(hint);
            }

            if (IsRoom(currentKey) && rightShowsMembers)
            {
                SideItem h2 = new SideItem();
                h2.Kind = "header";
                h2.Title = "本群成员";
                h2.Right = members.Count.ToString();
                items.Add(h2);
                List<string> ms = new List<string>(members);
                ms.Sort(StringComparer.OrdinalIgnoreCase);
                foreach (string u in ms)
                {
                    SideItem it = new SideItem();
                    it.Kind = "dm";
                    it.Key = "member:" + u;
                    it.Title = u + (u == me ? "（我）" : "");
                    it.Sub = online.Contains(u) ? "在线" : "离线";
                    it.Online = online.Contains(u);
                    it.AvatarUser = u;
                    it.AvatarUrl = AvatarOf(u);
                    items.Add(it);
                }
            }
            else
            {
            }

            rightList.SelectedKey = "";
            rightList.SetItems(items);
        }

        private void OnSideItem(SideItem item)
        {
            if (item.Kind == "action" && item.Key == "action:newroom")
            {
                string name = PromptBox.Ask(this, "新建群聊", "群名称（不存在会自动创建）", "");
                if (name == null) return;
                client.Send(Protocol.JOIN, Protocol.Data("room", name));
                return;
            }
            if (item.Key.StartsWith("user:") || item.Key.StartsWith("member:"))
            {
                int p = item.Key.IndexOf(':');
                OpenDm(item.Key.Substring(p + 1));
                return;
            }
            if (item.Kind == "room" || item.Kind == "dm")
            {
                SelectConv(item.Key);
            }
        }

        private string AvatarOf(string user)
        {
            string v;
            return avatars.TryGetValue(user, out v) ? v : "";
        }

        private void SelectConv(string key)
        {
            if (string.IsNullOrEmpty(key)) return;
            currentKey = key;
            Conversation c = EnsureConv(key);
            headerTitle.Text = c.IsRoom ? "#" + c.Name : c.Name;
            headerSub.Text = c.IsRoom
                ? members.Count + " 位成员 · " + CountOnlineMembers() + " 人在线"
                : (online.Contains(c.Name) ? "私聊 · 在线" : "私聊 · 离线");
            c.Unread = 0;
            messages.SetMessages(c.Messages);
            messages.ScrollToEnd();
            RebuildSidebar();
            RefreshRightPanel();
            input.Box.Focus();
            if (c.IsRoom) RefreshMembers(c.Name);
            LoadHistory(key, false);
            joinIfNeeded(c);
        }

        private int CountOnlineMembers()
        {
            int n = 0;
            foreach (string m in members) if (online.Contains(m)) n++;
            return n;
        }

        private Conversation EnsureConv(string key)
        {
            Conversation c;
            if (convs.TryGetValue(key, out c)) return c;
            c = new Conversation();
            c.Key = key;
            c.IsRoom = IsRoom(key);
            c.Name = c.IsRoom ? RoomOf(key) : DmOf(key);
            convs[key] = c;
            return c;
        }

        private void joinIfNeeded(Conversation c)
        {
            if (!c.IsRoom) return;
            if (joined.Contains(c.Name)) return;
            joined.Add(c.Name);
            client.Send(Protocol.JOIN, Protocol.Data("room", c.Name));
        }

        private void LoadHistory(string key, bool force)
        {
            if (string.IsNullOrEmpty(key)) return;
            Conversation c = EnsureConv(key);
            if (c.IsRoom)
            {
                client.Send(Protocol.HISTORY, Protocol.Data("room", c.Name, "limit", 120));
            }
            else
            {
                client.Send(Protocol.HISTORY, Protocol.Data("to", c.Name, "limit", 120));
            }
        }

        private void OpenDm(string user)
        {
            if (string.IsNullOrEmpty(user) || user == me) return;
            string key = "dm:" + user;
            Conversation c = EnsureConv(key);
            c.Name = user;
            SelectConv(key);
        }

        // ============================================================ 网络初始化
        private void LoadInitial()
        {
            clientsideInit();
        }

        private void clientsideInit()
        {
            // 房间列表来自 auth_ok
            List<object> rs = null;
            client.Send(Protocol.ROOMS, Protocol.Data());
            client.Send(Protocol.WHO, Protocol.Data());
            requestAllAvatarsSoon();

            string first = "";
            if (rooms.Count > 0) first = "room:" + rooms[0].Name;
            if (!string.IsNullOrEmpty(prefs.LastRoom))
            {
                if (prefs.LastRoom.StartsWith("room:"))
                {
                    string rn = RoomOf(prefs.LastRoom);
                    bool found = false;
                    foreach (RoomInfo r in rooms) if (r.Name == rn) found = true;
                    if (found) first = prefs.LastRoom;
                }
                else if (prefs.LastRoom.StartsWith("dm:"))
                {
                    first = prefs.LastRoom;
                }
            }
            if (!string.IsNullOrEmpty(first)) SelectConv(first);
        }

        private void requestAllAvatarsSoon()
        {
            // who 会返回头像表；这里不额外请求
        }

        public void SeedRooms(Dictionary<string, object> auth)
        {
            rooms.Clear();
            List<object> list = Json.List(auth.ContainsKey("rooms") ? auth["rooms"] : null);
            if (list == null) return;
            foreach (object o in list)
            {
                Dictionary<string, object> d = Json.Obj(o);
                if (d == null) continue;
                RoomInfo r = new RoomInfo();
                r.Name = Json.S(d, "name");
                r.Members = (int)Json.N(d, "memberCount");
                if (r.Name.Length > 0) rooms.Add(r);
            }
        }

        // ================================================================ 收帧
        private void PumpFrames()
        {
            string line;
            int guard = 0;
            while (guard++ < 300 && client.Incoming.TryDequeue(out line))
            {
                if (line == ChatClient.ClosedSentinel)
                {
                    OnDisconnected();
                    continue;
                }
                Dictionary<string, object> frame;
                try { frame = Json.Obj(Json.Parse(line)); }
                catch { continue; }
                if (frame == null) continue;
                try { HandleFrame(frame); }
                catch (Exception ex) { toast.Show("处理消息出错：" + ex.Message); }
            }
            if (whoQueued && Environment.TickCount - lastWho > 900)
            {
                whoQueued = false;
                RefreshWho();
            }
        }

        private void HandleFrame(Dictionary<string, object> frame)
        {
            string type = Json.S(frame, "type");
            Dictionary<string, object> d = Json.Obj(frame.ContainsKey("data") ? frame["data"] : null);
            if (d == null) d = new Dictionary<string, object>();

            switch (type)
            {
                case Protocol.MSG:
                    OnPrivate(d);
                    break;
                case Protocol.GROUP:
                    OnGroup(d);
                    break;
                case Protocol.SYSTEM:
                    OnSystem(d);
                    break;
                case Protocol.PRESENCE:
                    OnPresence(d);
                    break;
                case Protocol.WHO:
                    OnWho(d);
                    break;
                case Protocol.ROOMS:
                    OnRooms(d);
                    break;
                case Protocol.MEMBERS:
                    OnMembers(d);
                    break;
                case Protocol.HISTORY:
                    OnHistory(d);
                    break;
                case Protocol.PROFILE:
                    OnProfile(d);
                    break;
                case Protocol.ACK:
                    OnAck(d);
                    break;
                case Protocol.JOIN_OK:
                    OnJoinOk(d);
                    break;
                case Protocol.ERROR:
                    toast.Show(Json.S(d, "message"));
                    break;
                case Protocol.PONG:
                    break;
            }
        }

        private ChatMessage FromData(Dictionary<string, object> d, string kind)
        {
            ChatMessage m = new ChatMessage();
            m.Id = Json.S(d, "id");
            m.Kind = kind;
            m.Room = Json.S(d, "room");
            m.From = Json.S(d, "from");
            m.To = Json.S(d, "to");
            m.Text = Json.S(d, "text");
            m.Image = Json.S(d, "image");
            m.Ts = Json.N(d, "ts");
            if (m.Ts <= 0) m.Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            m.Self = m.From == me;
            m.Offline = Json.B(d, "offline");
            return m;
        }

        private void OnPrivate(Dictionary<string, object> d)
        {
            ChatMessage m = FromData(d, "dm");
            bool mine = m.From == me;
            string peer = mine ? m.To : m.From;
            string key = "dm:" + peer;
            Conversation c = EnsureConv(key);
            c.Name = peer;
            AppendTo(c, m, !mine && currentKey != key);
            EnsureAvatar(m.From);
            if (!mine && m.From != me && !IsActive())
            {
                try { SystemSounds.Asterisk.Play(); } catch { }
            }
        }

        private void OnGroup(Dictionary<string, object> d)
        {
            ChatMessage m = FromData(d, "group");
            string key = "room:" + m.Room;
            Conversation c = EnsureConv(key);
            c.Name = m.Room;
            bool mine = m.From == me;
            AppendTo(c, m, !mine && currentKey != key);
            EnsureAvatar(m.From);
            if (!mine && !IsActive())
            {
                try { SystemSounds.Asterisk.Play(); } catch { }
            }
        }

        private void OnAck(Dictionary<string, object> d)
        {
            if (!Json.B(d, "ok")) { toast.Show(Json.S(d, "message")); return; }
            string kind = Json.S(d, "kind");
            Dictionary<string, object> md = Json.Obj(d.ContainsKey("message") ? d["message"] : null);
            if (md != null)
            {
                ChatMessage m = FromData(md, kind == "group" ? "group" : "dm");
                m.Self = true;
                string key = m.Kind == "group" ? "room:" + m.Room : "dm:" + m.To;
                Conversation c = EnsureConv(key);
                c.Name = m.Kind == "group" ? m.Room : m.To;
                if (!Contains(c, m.Id)) AppendTo(c, m, false);
            }
            if (!Json.B(d, "delivered") && Json.S(d, "note").Length > 0)
            {
                toast.Show(Json.S(d, "note"));
            }
        }

        private static bool Contains(Conversation c, string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            for (int i = c.Messages.Count - 1; i >= 0; i--)
            {
                if (c.Messages[i].Id == id) return true;
            }
            return false;
        }

        private void AppendTo(Conversation c, ChatMessage m, bool unread)
        {
            if (!string.IsNullOrEmpty(m.Id) && Contains(c, m.Id)) return;
            c.Messages.Add(m);
            if (c.Messages.Count > 600) c.Messages.RemoveRange(0, c.Messages.Count - 600);
            c.LastTs = m.Ts;
            c.Preview = PreviewOf(m);
            if (unread) c.Unread++;
            else if (currentKey == c.Key) c.Unread = 0;

            if (currentKey == c.Key)
            {
                messages.Add(m);
                headerSub.Text = c.IsRoom
                    ? members.Count + " 位成员 · " + CountOnlineMembers() + " 人在线"
                    : (online.Contains(c.Name) ? "私聊 · 在线" : "私聊 · 离线");
            }
            RebuildSidebar();
        }

        private static string PreviewOf(ChatMessage m)
        {
            if (!string.IsNullOrEmpty(m.Text)) return m.Text.Replace("\r", " ").Replace("\n", " ");
            if (!string.IsNullOrEmpty(m.Image)) return "[图片]";
            return "";
        }

        private void OnSystem(Dictionary<string, object> d)
        {
            string ev = Json.S(d, "event");
            switch (ev)
            {
                case "welcome":
                    serverName = Json.S(d, "server");
                    break;
                case "announcement":
                    {
                        ChatMessage m = new ChatMessage();
                        m.Kind = "system";
                        m.IsSystem = true;
                        m.IsAnnouncement = true;
                        m.Text = Json.S(d, "text");
                        m.From = Json.S(d, "from");
                        m.Ts = Json.N(d, "ts");
                        if (m.Ts <= 0) m.Ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        string key = !string.IsNullOrEmpty(currentKey) ? currentKey : FirstKey();
                        if (key != null)
                        {
                            Conversation c = EnsureConv(key);
                            c.Messages.Add(m);
                            if (currentKey == key) messages.Add(m);
                        }
                        toast.Show("公告：" + m.Text);
                        break;
                    }
                case "user_joined":
                    online.Add(Json.S(d, "user"));
                    QueueWho();
                    RebuildSidebar();
                    RefreshRightPanel();
                    break;
                case "user_left":
                    online.Remove(Json.S(d, "user"));
                    QueueWho();
                    RebuildSidebar();
                    RefreshRightPanel();
                    break;
                case "avatar":
                    {
                        string u = Json.S(d, "user");
                        avatars[u] = Json.S(d, "avatar");
                        if (u == me) myAvatar = avatars[u];
                        RebuildSidebar();
                        RefreshRightPanel();
                        messages.Invalidate();
                        break;
                    }
                case "member_joined":
                case "member_left":
                    if (Json.S(d, "room") == RoomOf(currentKey)) RefreshMembers(Json.S(d, "room"));
                    break;
            }
        }

        private string FirstKey()
        {
            if (rooms.Count > 0) return "room:" + rooms[0].Name;
            return null;
        }

        private void OnPresence(Dictionary<string, object> d)
        {
            string user = Json.S(d, "user");
            bool on = Json.B(d, "online");
            if (on) online.Add(user); else online.Remove(user);
            QueueWho();
            RebuildSidebar();
            RefreshRightPanel();
        }

        private void QueueWho()
        {
            if (whoQueued) return;
            whoQueued = true;
            lastWho = Environment.TickCount;
        }

        private void RefreshWho()
        {
            client.Send(Protocol.WHO, Protocol.Data());
        }

        private void OnWho(Dictionary<string, object> d)
        {
            online.Clear();
            List<object> users = Json.List(d.ContainsKey("users") ? d["users"] : null);
            if (users != null)
            {
                foreach (object o in users)
                {
                    string u = Convert.ToString(o);
                    if (!string.IsNullOrEmpty(u)) online.Add(u);
                }
            }
            Dictionary<string, object> av = Json.Obj(d.ContainsKey("avatars") ? d["avatars"] : null);
            if (av != null)
            {
                foreach (KeyValuePair<string, object> kv in av)
                {
                    avatars[kv.Key] = Convert.ToString(kv.Value);
                }
            }
            RebuildSidebar();
            RefreshRightPanel();
            messages.Invalidate();
        }

        private void OnRooms(Dictionary<string, object> d)
        {
            List<object> list = Json.List(d.ContainsKey("rooms") ? d["rooms"] : null);
            if (list == null) return;
            rooms.Clear();
            foreach (object o in list)
            {
                Dictionary<string, object> rd = Json.Obj(o);
                if (rd == null) continue;
                RoomInfo r = new RoomInfo();
                r.Name = Json.S(rd, "name");
                r.Members = (int)Json.N(rd, "memberCount");
                if (r.Name.Length > 0) rooms.Add(r);
            }
            RebuildSidebar();
        }

        private void OnMembers(Dictionary<string, object> d)
        {
            string room = Json.S(d, "room");
            if (room != RoomOf(currentKey)) return;
            members.Clear();
            List<object> list = Json.List(d.ContainsKey("members") ? d["members"] : null);
            if (list != null)
            {
                foreach (object o in list)
                {
                    string u = Convert.ToString(o);
                    if (!string.IsNullOrEmpty(u)) members.Add(u);
                }
            }
            headerSub.Text = members.Count + " 位成员 · " + CountOnlineMembers() + " 人在线";
            foreach (RoomInfo r in rooms)
            {
                if (r.Name == room) r.Members = members.Count;
            }
            RefreshRightPanel();
            RebuildSidebar();
        }

        private void RefreshMembers(string room)
        {
            if (string.IsNullOrEmpty(room)) return;
            client.Send(Protocol.MEMBERS, Protocol.Data("room", room));
        }

        private void OnHistory(Dictionary<string, object> d)
        {
            string scope = Json.S(d, "scope");
            string key = scope == "room" ? "room:" + Json.S(d, "room") : "dm:" + Json.S(d, "with");
            Conversation c = EnsureConv(key);
            List<object> list = Json.List(d.ContainsKey("messages") ? d["messages"] : null);
            if (list == null) return;

            List<ChatMessage> hist = new List<ChatMessage>();
            foreach (object o in list)
            {
                Dictionary<string, object> md = Json.Obj(o);
                if (md == null) continue;
                ChatMessage m = FromData(md, c.IsRoom ? "group" : "dm");
                hist.Add(m);
                EnsureAvatar(m.From);
            }
            // 合并：保留本地已有（可能是刚发的），历史放前面
            List<ChatMessage> merged = new List<ChatMessage>();
            HashSet<string> seen = new HashSet<string>();
            foreach (ChatMessage m in hist)
            {
                if (!string.IsNullOrEmpty(m.Id) && seen.Contains(m.Id)) continue;
                if (!string.IsNullOrEmpty(m.Id)) seen.Add(m.Id);
                merged.Add(m);
            }
            foreach (ChatMessage m in c.Messages)
            {
                if (!string.IsNullOrEmpty(m.Id) && seen.Contains(m.Id)) continue;
                if (!string.IsNullOrEmpty(m.Id)) seen.Add(m.Id);
                merged.Add(m);
            }
            merged.Sort(delegate (ChatMessage a, ChatMessage b) { return a.Ts.CompareTo(b.Ts); });
            c.Messages.Clear();
            c.Messages.AddRange(merged);
            if (c.LastTs == 0 && merged.Count > 0)
            {
                c.LastTs = merged[merged.Count - 1].Ts;
                c.Preview = PreviewOf(merged[merged.Count - 1]);
            }
            if (currentKey == key)
            {
                messages.SetMessages(c.Messages);
                messages.ScrollToEnd();
            }
            RebuildSidebar();
        }

        private void OnProfile(Dictionary<string, object> d)
        {
            string user = Json.S(d, "user");
            string avatar = Json.S(d, "avatar");
            if (user.Length == 0) return;
            avatars[user] = avatar;
            if (user == me)
            {
                myAvatar = avatar;
                myAvatarBox.DataUrl = avatar;
                myAvatarBox.Invalidate();
            }
            messages.Invalidate();
            RebuildSidebar();
            RefreshRightPanel();
        }

        private void OnJoinOk(Dictionary<string, object> d)
        {
            string room = Json.S(d, "room");
            if (room.Length == 0) return;
            bool found = false;
            foreach (RoomInfo r in rooms) if (r.Name == room) found = true;
            if (!found)
            {
                RoomInfo r = new RoomInfo();
                r.Name = room;
                List<object> ms = Json.List(d.ContainsKey("members") ? d["members"] : null);
                r.Members = ms != null ? ms.Count : 1;
                rooms.Add(r);
                rooms.Sort(delegate (RoomInfo a, RoomInfo b) { return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase); });
            }
            joined.Add(room);
            RebuildSidebar();
            if (currentKey != "room:" + room) SelectConv("room:" + room);
            else RefreshMembers(room);
        }

        private void EnsureAvatar(string user)
        {
            if (string.IsNullOrEmpty(user) || user == me) return;
            if (avatars.ContainsKey(user) || avatarRequested.Contains(user)) return;
            avatarRequested.Add(user);
            client.Send(Protocol.PROFILE, Protocol.Data("action", "get", "user", user));
        }

        // ================================================================ 发送
        private void InputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                e.Handled = true;
                SendCurrent();
            }
        }

        private void SendCurrent()
        {
            if (string.IsNullOrEmpty(currentKey))
            {
                toast.Show("请先在左侧选择一个群聊或私聊");
                return;
            }
            string text = input.Value.TrimEnd('\r', '\n');
            if (text.Length == 0 && pendingImage == null) return;
            if (text.Length > Protocol.MAX_TEXT)
            {
                toast.Show("消息太长（上限 " + Protocol.MAX_TEXT + " 字）");
                return;
            }
            Conversation c = EnsureConv(currentKey);
            Dictionary<string, object> data = new Dictionary<string, object>();
            if (c.IsRoom)
            {
                data["room"] = c.Name;
                data["text"] = text;
                if (pendingImage != null) data["image"] = pendingImage;
                client.Send(Protocol.GROUP, data);
            }
            else
            {
                data["to"] = c.Name;
                data["text"] = text;
                if (pendingImage != null) data["image"] = pendingImage;
                client.Send(Protocol.MSG, data);
            }
            input.Value = "";
            ClearAttachment();
            UpdateCharCount();
            input.Box.Focus();
            // 回车键在个别输入法/消息路径下可能残留一个换行，下一拍再清一次
            BeginInvoke((MethodInvoker)delegate
            {
                if (input.Value.Length > 0 && input.Value.Trim().Length == 0) input.Value = "";
                UpdateCharCount();
            });
        }

        private void PickImage()
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择要发送的图片";
                dlg.Filter = "图片文件|*.jpg;*.jpeg;*.png;*.gif;*.bmp;*.webp|所有文件|*.*";
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                AttachImage(dlg.FileName);
            }
        }

        private void AttachImage(string path)
        {
            try
            {
                Cursor = Cursors.WaitCursor;
                string dataUrl = ImageTools.ToDataUrl(path, 1280, Protocol.MAX_IMAGE_LEN - 20000);
                pendingImage = dataUrl;
                pendingImageName = Path.GetFileName(path);
                attachThumb.Image = ImageTools.FromDataUrl(dataUrl, Ui.S(168), Ui.S(104));
                attachName.Text = pendingImageName + "　·　" + (dataUrl.Length / 1024) + " KB";
                attachPanel.Visible = true;
                LayoutChildren();
                toast.Show("图片已添加，点发送即可发出");
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, "无法添加图片", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally
            {
                Cursor = Cursors.Default;
            }
        }

        private void ClearAttachment()
        {
            pendingImage = null;
            pendingImageName = "";
            if (attachThumb.Image != null)
            {
                Image old = attachThumb.Image;
                attachThumb.Image = null;
                try { old.Dispose(); } catch { }
            }
            attachPanel.Visible = false;
            LayoutChildren();
        }

        private void OnDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
            else e.Effect = DragDropEffects.None;
        }

        private void OnDragDrop(object sender, DragEventArgs e)
        {
            string[] files = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (files == null || files.Length == 0) return;
            string f = files[0];
            string ext = Path.GetExtension(f).ToLowerInvariant();
            if (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".gif" || ext == ".bmp" || ext == ".webp")
            {
                AttachImage(f);
            }
            else
            {
                toast.Show("只能发送图片文件");
            }
        }

        // ================================================================ 其它
        private void ShowProfileMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = Ui.F(9f);
            menu.Items.Add("更换头像…", null, delegate { ChangeAvatar(); });
            menu.Items.Add("我的资料", null, delegate
            {
                MessageBox.Show(this,
                    "用户名：" + me + "\n服务器：" + host + ":" + port + "\n服务端名称：" + (serverName.Length > 0 ? serverName : "-"),
                    "我的资料", MessageBoxButtons.OK, MessageBoxIcon.Information);
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出登录", null, delegate { Logout(); });
            menu.Show(myAvatarBox, new Point(0, myAvatarBox.Height));
        }

        private void ChangeAvatar()
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "选择头像";
                dlg.Filter = "图片文件|*.jpg;*.jpeg;*.png;*.gif;*.bmp;*.webp";
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    Cursor = Cursors.WaitCursor;
                    string url = ImageTools.ToDataUrl(dlg.FileName, 160, Protocol.MAX_AVATAR_LEN - 4000);
                    client.Send(Protocol.PROFILE, Protocol.Data("action", "set", "avatar", url));
                    avatars[me] = url;
                    myAvatar = url;
                    myAvatarBox.DataUrl = url;
                    myAvatarBox.Invalidate();
                    messages.Invalidate();
                    RebuildSidebar();
                    toast.Show("头像已更新");
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, ex.Message, "设置头像失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                finally { Cursor = Cursors.Default; }
            }
        }

        private void ShowImage(string dataUrl)
        {
            Image img = ImageCache.Get(dataUrl);
            if (img == null)
            {
                toast.Show("图片已失效");
                return;
            }
            using (ImageViewer v = new ImageViewer(img, dataUrl))
            {
                v.ShowDialog(this);
            }
        }

        private void Logout()
        {
            try { client.Close(); } catch { }
            Close();
        }

        private void OnDisconnected()
        {
            if (disconnectHandled) return;
            disconnectHandled = true;
            headerSub.Text = "连接已断开";
            headerSub.ForeColor = Theme.Red;
            reconnectButton.Visible = true;
            LayoutChildren();
            toast.Show("与服务器的连接已断开，可点「重新连接」");
            RebuildSidebar();
        }

        private void Reconnect()
        {
            reconnectButton.Enabled = false;
            toast.Show("正在重新连接…");
            string h = host;
            int p = port;
            string u = me;
            string pw = password;
            Task.Run(delegate
            {
                try
                {
                    Dictionary<string, object> auth;
                    ChatClient c = ChatClient.ConnectAuth(h, p, u, pw, 8000, out auth);
                    BeginInvoke((MethodInvoker)delegate { ApplyReconnect(c, auth); });
                }
                catch (Exception ex)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        reconnectButton.Enabled = true;
                        toast.Show("重连失败：" + ex.Message);
                    });
                }
            });
        }

        private void ApplyReconnect(ChatClient c, Dictionary<string, object> auth)
        {
            try { client.Close(); } catch { }
            client = c;
            disconnectHandled = false;
            reconnectButton.Enabled = true;
            reconnectButton.Visible = false;
            headerSub.ForeColor = Theme.Muted;
            online.Clear();
            members.Clear();
            joined.Clear();
            avatarRequested.Clear();
            SeedRooms(auth);
            myAvatar = Json.S(auth, "avatar");
            myAvatarBox.DataUrl = myAvatar;
            RebuildSidebar();
            RefreshWho();
            if (!string.IsNullOrEmpty(currentKey))
            {
                Conversation conv = EnsureConv(currentKey);
                joinIfNeeded(conv);
                LoadHistory(currentKey, true);
            }
            toast.Show("已重新连接");
        }

        private bool IsActive()
        {
            return ContainsFocus || Form.ActiveForm == this;
        }
    }
}
