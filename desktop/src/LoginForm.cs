using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace NodeChat
{
    /// <summary>
    /// 登录页：最近登录过的服务端（host:port）会记在本地，点一下即可回填；
    /// 也支持直接粘 "192.168.1.8:9099" 这种地址。
    /// </summary>
    internal sealed class LoginForm : Form
    {
        private readonly ServerStore store = new ServerStore();
        private readonly Prefs prefs = Prefs.Load();
        private readonly List<ServerEntry> recent = new List<ServerEntry>();

        private Panel card;
        private ComboBox recentBox;
        private FlatButton forgetButton;
        private TextField hostField;
        private TextField portField;
        private TextField userField;
        private TextField passField;
        private CheckBox rememberBox;
        private FlatButton connectButton;
        private FlatButton localButton;
        private Label messageLabel;
        private bool busy;

        private static readonly Regex NameRe = new Regex(@"^[A-Za-z0-9_\u4e00-\u9fa5.\-]{1,24}$");

        public LoginForm()
        {
            Text = "Node Chat · 登录";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(Ui.S(520), Ui.S(640));
            BackColor = Color.FromArgb(246, 248, 252);
            Font = Ui.F(9f);
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            KeyPreview = true;
            store.Load();

            BuildUi();
            LoadRecent();
            ApplyLast();
            ApplyCommandLine();
            KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Enter && !busy && !passField.Box.Focused) { Connect(); }
            };
        }

        private void BuildUi()
        {
            card = new Panel();
            card.SetBounds(Ui.S(46), Ui.S(52), Ui.S(428), Ui.S(500));
            card.BackColor = Color.White;
            card.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle r = new Rectangle(0, 0, card.Width - 1, card.Height - 1);
                using (GraphicsPath p = Ui.Round(r, Ui.S(16)))
                using (SolidBrush b = new SolidBrush(Color.White))
                {
                    e.Graphics.FillPath(b, p);
                }
                Ui.StrokeRound(e.Graphics, r, Ui.S(16), Color.FromArgb(232, 235, 243), 1f);
            };
            Controls.Add(card);

            Panel logo = new Panel();
            logo.SetBounds(Ui.S(28), Ui.S(26), Ui.S(42), Ui.S(42));
            logo.BackColor = Color.Transparent;
            logo.Paint += delegate (object s, PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle r = new Rectangle(0, 0, logo.Width, logo.Height);
                Ui.FillRound(e.Graphics, r, Ui.S(12), Theme.Accent);
                TextRenderer.DrawText(e.Graphics, "N", Ui.F(16f, true), r, Color.White,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            };
            card.Controls.Add(logo);

            Label title = new Label();
            title.Text = "Node Chat";
            title.Font = Ui.F(16f, true);
            title.ForeColor = Theme.Text;
            title.AutoSize = true;
            title.BackColor = Color.Transparent;
            title.Location = new Point(Ui.S(84), Ui.S(24));
            card.Controls.Add(title);

            Label sub = new Label();
            sub.Text = "轻量即时消息客户端 · 原生界面，无内嵌浏览器";
            sub.Font = Ui.F(8.2f);
            sub.ForeColor = Theme.Muted;
            sub.AutoSize = true;
            sub.BackColor = Color.Transparent;
            sub.Location = new Point(Ui.S(85), Ui.S(50));
            card.Controls.Add(sub);

            Label l1 = SmallLabel("最近登录");
            l1.Location = new Point(Ui.S(28), Ui.S(92));
            card.Controls.Add(l1);

            recentBox = new ComboBox();
            recentBox.DropDownStyle = ComboBoxStyle.DropDownList;
            recentBox.FlatStyle = FlatStyle.Flat;
            recentBox.Font = Ui.F(9f);
            recentBox.BackColor = Color.White;
            recentBox.ForeColor = Theme.Text;
            recentBox.SetBounds(Ui.S(28), Ui.S(112), Ui.S(316), Ui.S(30));
            recentBox.SelectedIndexChanged += delegate { OnRecentPicked(); };
            card.Controls.Add(recentBox);

            forgetButton = new FlatButton();
            forgetButton.Text = "删除";
            forgetButton.Kind = ButtonKind.Link;
            forgetButton.Font = Ui.F(8.5f);
            forgetButton.SetBounds(Ui.S(350), Ui.S(112), Ui.S(50), Ui.S(30));
            forgetButton.Click += delegate { ForgetSelected(); };
            card.Controls.Add(forgetButton);

            Label l2 = SmallLabel("服务器地址");
            l2.Location = new Point(Ui.S(28), Ui.S(156));
            card.Controls.Add(l2);

            hostField = new TextField(false);
            hostField.SetPlaceholder("IP 或主机名，如 192.168.1.8");
            hostField.SetBounds(Ui.S(28), Ui.S(176), Ui.S(272), Ui.S(40));
            card.Controls.Add(hostField);

            portField = new TextField(false);
            portField.SetPlaceholder("端口");
            portField.SetBounds(Ui.S(310), Ui.S(176), Ui.S(90), Ui.S(40));
            card.Controls.Add(portField);

            Label l3 = SmallLabel("用户名");
            l3.Location = new Point(Ui.S(28), Ui.S(232));
            card.Controls.Add(l3);

            userField = new TextField(false);
            userField.SetPlaceholder("首次登录会自动注册");
            userField.SetBounds(Ui.S(28), Ui.S(252), Ui.S(372), Ui.S(40));
            card.Controls.Add(userField);

            Label l4 = SmallLabel("密码（可留空）");
            l4.Location = new Point(Ui.S(28), Ui.S(308));
            card.Controls.Add(l4);

            passField = new TextField(false);
            passField.SetPlaceholder("留空即免密码登录");
            passField.Box.UseSystemPasswordChar = true;
            passField.SetBounds(Ui.S(28), Ui.S(328), Ui.S(372), Ui.S(40));
            card.Controls.Add(passField);

            rememberBox = new CheckBox();
            rememberBox.Text = "记住这台服务器（只记地址和用户名，不记密码）";
            rememberBox.Font = Ui.F(8.2f);
            rememberBox.ForeColor = Theme.Muted;
            rememberBox.AutoSize = true;
            rememberBox.BackColor = Color.Transparent;
            rememberBox.Location = new Point(Ui.S(26), Ui.S(380));
            rememberBox.Checked = prefs.RememberServer;
            card.Controls.Add(rememberBox);

            connectButton = new FlatButton();
            connectButton.Text = "连  接";
            connectButton.Kind = ButtonKind.Primary;
            connectButton.Radius = Ui.S(9);
            connectButton.Font = Ui.F(10f, true);
            connectButton.SetBounds(Ui.S(28), Ui.S(410), Ui.S(372), Ui.S(44));
            connectButton.Click += delegate { Connect(); };
            card.Controls.Add(connectButton);

            localButton = new FlatButton();
            localButton.Text = "用本机服务端（127.0.0.1:9099）";
            localButton.Kind = ButtonKind.Link;
            localButton.Font = Ui.F(8.2f);
            localButton.SetBounds(Ui.S(28), Ui.S(458), Ui.S(220), Ui.S(22));
            localButton.Click += delegate
            {
                hostField.Value = "127.0.0.1";
                portField.Value = Protocol.DEFAULT_PORT.ToString();
                userField.Box.Focus();
            };
            card.Controls.Add(localButton);

            messageLabel = new Label();
            messageLabel.AutoSize = false;
            messageLabel.ForeColor = Theme.Red;
            messageLabel.Font = Ui.F(8.2f);
            messageLabel.BackColor = Color.Transparent;
            messageLabel.TextAlign = ContentAlignment.MiddleRight;
            messageLabel.SetBounds(Ui.S(240), Ui.S(458), Ui.S(160), Ui.S(22));
            card.Controls.Add(messageLabel);

            Label footer = new Label();
            footer.Text = "协议：TCP + NDJSON　·　与 PC / 安卓端完全互通";
            footer.Font = Ui.F(7.8f);
            footer.ForeColor = Color.FromArgb(176, 183, 198);
            footer.AutoSize = true;
            footer.BackColor = Color.Transparent;
            footer.Location = new Point(Ui.S(46), Ui.S(570));
            Controls.Add(footer);
        }

        private static Label SmallLabel(string text)        {
            Label l = new Label();
            l.Text = text;
            l.Font = Ui.F(8.5f, true);
            l.ForeColor = Color.FromArgb(120, 129, 149);
            l.AutoSize = true;
            l.BackColor = Color.Transparent;
            return l;
        }

        // ------------------------------------------------------------ 命令行
        /// <summary>
        /// 支持 NodeChat.exe --host 192.168.1.8 --port 9099 --user alice --pass 123456
        /// 直接登录（方便做桌面快捷方式，也方便自动化测试）。
        /// </summary>
        private void ApplyCommandLine()
        {
            string[] args = Environment.GetCommandLineArgs();
            string host = null, user = null, pass = null, port = null;
            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i].ToLowerInvariant();
                if (i + 1 >= args.Length) break;
                if (a == "--host" || a == "-h") host = args[++i];
                else if (a == "--port" || a == "-p") port = args[++i];
                else if (a == "--user" || a == "-u") user = args[++i];
                else if (a == "--pass" || a == "--password" || a == "-k") pass = args[++i];
            }
            if (host != null) hostField.Value = host;
            if (port != null) portField.Value = port;
            if (user != null) userField.Value = user;
            if (pass != null) passField.Value = pass;

            if (host != null && user != null)
            {
                Shown += delegate { BeginInvoke((MethodInvoker)Connect); };
            }
        }

        // ------------------------------------------------------------ 最近记录
        private void LoadRecent()
        {
            recent.Clear();
            recent.AddRange(store.Entries);
            recentBox.Items.Clear();
            foreach (ServerEntry e in recent)
            {
                recentBox.Items.Add(e.Display + "        " + e.When);
            }
            if (recent.Count == 0)
            {
                recentBox.Items.Add("（还没有记录，填一个地址登录后会自动记住）");
                recentBox.SelectedIndex = 0;
                recentBox.Enabled = false;
                forgetButton.Enabled = false;
            }
            else
            {
                recentBox.Enabled = true;
                forgetButton.Enabled = true;
                recentBox.SelectedIndex = 0;
            }
        }

        private void ApplyLast()
        {
            if (recent.Count > 0)
            {
                ServerEntry e = recent[0];
                hostField.Value = e.Host;
                portField.Value = e.Port.ToString();
                userField.Value = e.User;
                rememberBox.Checked = prefs.RememberServer;
            }
            else
            {
                hostField.Value = prefs.LastHost.Length > 0 ? prefs.LastHost : "127.0.0.1";
                portField.Value = prefs.LastPort.Length > 0 ? prefs.LastPort : Protocol.DEFAULT_PORT.ToString();
                userField.Value = prefs.LastUser;
            }
            if (string.IsNullOrEmpty(passField.Value)) passField.Value = "";
            ActiveControl = userField.Box;
        }

        private void OnRecentPicked()
        {
            int i = recentBox.SelectedIndex;
            if (i < 0 || i >= recent.Count) return;
            ServerEntry e = recent[i];
            hostField.Value = e.Host;
            portField.Value = e.Port.ToString();
            userField.Value = e.User;
            messageLabel.Text = "";
        }

        private void ForgetSelected()
        {
            int i = recentBox.SelectedIndex;
            if (i < 0 || i >= recent.Count) return;
            ServerEntry e = recent[i];
            if (MessageBox.Show(this, "删除记录 " + e.Key + " ？", "删除记录",
                MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            store.Forget(e.Key);
            LoadRecent();
        }

        // -------------------------------------------------------------- 连接
        private void Connect()
        {
            if (busy) return;
            string host = hostField.Value.Trim();
            string portText = portField.Value.Trim();
            string user = userField.Value.Trim();
            string pass = passField.Value;

            // 支持直接粘贴 host:port
            if (host.Contains(":") && !host.Contains("://"))
            {
                int idx = host.LastIndexOf(':');
                string p = host.Substring(idx + 1);
                int parsed;
                if (int.TryParse(p, out parsed) && parsed > 0 && parsed <= 65535)
                {
                    portText = p;
                    host = host.Substring(0, idx);
                }
            }
            if (host.Length == 0) { Fail("请填写服务器地址", hostField); return; }
            int port;
            if (!int.TryParse(portText, out port) || port <= 0 || port > 65535) { Fail("端口需为 1~65535", portField); return; }
            if (!NameRe.IsMatch(user)) { Fail("用户名 1~24 位，仅支持字母/数字/下划线/中文/点/横线", userField); return; }
            // 密码可选：服务端没开 requirePassword 时留空即可登录

            busy = true;
            messageLabel.ForeColor = Theme.Muted;
            messageLabel.Text = "正在连接…";
            connectButton.Enabled = false;
            connectButton.Text = "连接中…";
            Cursor = Cursors.WaitCursor;

            string h = host;
            int p2 = port;
            string u = user;
            string pw = pass;

            Task.Run(delegate
            {
                try
                {
                    Dictionary<string, object> auth;
                    ChatClient c = ChatClient.ConnectAuth(h, p2, u, pw, 9000, out auth);
                    BeginInvoke((MethodInvoker)delegate { OnConnected(c, auth, h, p2, u, pw); });
                }
                catch (Exception ex)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        busy = false;
                        Cursor = Cursors.Default;
                        connectButton.Enabled = true;
                        connectButton.Text = "连  接";
                        Fail(ex.Message, null);
                    });
                }
            });
        }

        private void Fail(string msg, TextField focus)
        {
            messageLabel.ForeColor = Theme.Red;
            messageLabel.Text = msg;
            if (focus != null) focus.Box.Focus();
        }

        private void OnConnected(ChatClient c, Dictionary<string, object> auth, string host, int port, string user, string pw)
        {
            busy = false;
            Cursor = Cursors.Default;
            connectButton.Enabled = true;
            connectButton.Text = "连  接";
            messageLabel.ForeColor = Theme.Green;
            messageLabel.Text = "已连接";

            if (rememberBox.Checked) store.Remember(host, port, user);
            prefs.LastHost = host;
            prefs.LastPort = port.ToString();
            prefs.LastUser = user;
            prefs.RememberServer = rememberBox.Checked;
            prefs.Save();

            Hide();
            try
            {
                using (MainForm main = new MainForm(c, host, port, pw, prefs, auth))
                {
                    main.ShowDialog(this);
                }
            }
            finally
            {
                Show();
                store.Load();
                LoadRecent();
                passField.Value = "";
                ActiveControl = passField.Box;
                messageLabel.Text = "";
                messageLabel.ForeColor = Theme.Red;
            }
        }
    }
}
