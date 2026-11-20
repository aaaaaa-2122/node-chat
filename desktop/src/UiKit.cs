using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace NodeChat
{
    internal static class Theme
    {
        public static readonly Color Bg = Color.FromArgb(241, 243, 248);
        public static readonly Color Surface = Color.White;
        public static readonly Color Sidebar = Color.FromArgb(252, 253, 255);
        public static readonly Color Border = Color.FromArgb(228, 231, 239);
        public static readonly Color Divider = Color.FromArgb(238, 240, 246);
        public static readonly Color Text = Color.FromArgb(27, 33, 48);
        public static readonly Color Muted = Color.FromArgb(138, 146, 166);
        public static readonly Color Faint = Color.FromArgb(170, 177, 192);
        public static readonly Color Accent = Color.FromArgb(47, 107, 255);
        public static readonly Color AccentDark = Color.FromArgb(36, 85, 216);
        public static readonly Color AccentSoft = Color.FromArgb(234, 241, 255);
        public static readonly Color Green = Color.FromArgb(35, 178, 109);
        public static readonly Color Red = Color.FromArgb(229, 72, 77);
        public static readonly Color BubbleOther = Color.White;
        public static readonly Color Hover = Color.FromArgb(245, 247, 251);
        public static readonly Color SelfBubble = Color.FromArgb(47, 107, 255);
    }

    internal static class Ui
    {
        /// <summary>DPI 缩放系数（96dpi = 1.0）</summary>
        public static float K = 1f;

        public static int S(int v)
        {
            return (int)Math.Round(v * K);
        }

        private static readonly Dictionary<string, Font> fonts = new Dictionary<string, Font>();

        public static Font F(float size)
        {
            return F(size, false);
        }

        public static Font F(float size, bool bold)
        {
            string key = size.ToString("0.##") + (bold ? "b" : "r");
            Font f;
            if (fonts.TryGetValue(key, out f)) return f;
            string[] names = new string[] { "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Tahoma" };
            f = null;
            foreach (string n in names)
            {
                try
                {
                    f = new Font(n, size, bold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Point);
                    break;
                }
                catch { }
            }
            if (f == null) f = new Font(FontFamily.GenericSansSerif, size, bold ? FontStyle.Bold : FontStyle.Regular);
            fonts[key] = f;
            return f;
        }

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = Math.Max(1, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
            if (d <= 2)
            {
                p.AddRectangle(r);
                return p;
            }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Rectangle r, int radius, Color color)
        {
            if (r.Width <= 0 || r.Height <= 0) return;
            using (GraphicsPath p = Round(r, radius))
            using (SolidBrush b = new SolidBrush(color))
            {
                g.FillPath(b, p);
            }
        }

        public static void StrokeRound(Graphics g, Rectangle r, int radius, Color color, float width)
        {
            if (r.Width <= 1 || r.Height <= 1) return;
            Rectangle rr = new Rectangle(r.X, r.Y, r.Width - 1, r.Height - 1);
            using (GraphicsPath p = Round(rr, radius))
            using (Pen pen = new Pen(color, width))
            {
                g.DrawPath(pen, p);
            }
        }

        public static readonly TextFormatFlags WrapFlags =
            TextFormatFlags.NoPadding | TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl;

        public static Size Measure(string text, Font font, int maxWidth)
        {
            if (string.IsNullOrEmpty(text)) return Size.Empty;
            return TextRenderer.MeasureText(text, font, new Size(Math.Max(1, maxWidth), int.MaxValue), WrapFlags);
        }

        public static Size Measure(string text, Font font)
        {
            return TextRenderer.MeasureText(text, font, Size.Empty, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        }

        public static void Draw(Graphics g, string text, Font font, Color color, Rectangle rect)
        {
            TextRenderer.DrawText(g, text, font, rect, color, WrapFlags);
        }

        public static void DrawLine(Graphics g, string text, Font font, Color color, Rectangle rect, TextFormatFlags flags)
        {
            TextRenderer.DrawText(g, text, font, rect, color, flags);
        }

        public static string Hm(long ms)
        {
            if (ms <= 0) return "";
            try { return DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().ToString("HH:mm"); }
            catch { return ""; }
        }

        public static string DayLabel(long ms)
        {
            DateTime t = DateTimeOffset.FromUnixTimeMilliseconds(ms).ToLocalTime().Date;
            DateTime today = DateTime.Today;
            if (t == today) return "今天";
            if (t == today.AddDays(-1)) return "昨天";
            if (t.Year == today.Year) return t.ToString("M月d日");
            return t.ToString("yyyy年M月d日");
        }

        public static bool SameDay(long a, long b)
        {
            if (a <= 0 || b <= 0) return true;
            return DateTimeOffset.FromUnixTimeMilliseconds(a).ToLocalTime().Date ==
                   DateTimeOffset.FromUnixTimeMilliseconds(b).ToLocalTime().Date;
        }

        private static readonly Color[] avatarColors = new Color[]
        {
            Color.FromArgb(94, 129, 244), Color.FromArgb(91, 191, 156), Color.FromArgb(244, 156, 92),
            Color.FromArgb(214, 118, 191), Color.FromArgb(104, 178, 220), Color.FromArgb(232, 130, 130),
            Color.FromArgb(150, 137, 234), Color.FromArgb(239, 176, 84)
        };

        public static Color AvatarColor(string name)
        {
            if (string.IsNullOrEmpty(name)) return avatarColors[0];
            int h = 0;
            for (int i = 0; i < name.Length; i++) h = (h * 31 + name[i]) & 0x7fffffff;
            return avatarColors[h % avatarColors.Length];
        }

        public static string Initial(string name)
        {
            if (string.IsNullOrEmpty(name)) return "?";
            return name.Substring(0, 1).ToUpperInvariant();
        }

        /// <summary>画圆形头像；没有图片时用用户名首字 + 稳定配色</summary>
        public static void DrawAvatar(Graphics g, Rectangle r, Image img, string name)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (img != null)
            {
                using (GraphicsPath p = new GraphicsPath())
                {
                    p.AddEllipse(r);
                    using (TextureBrush tb = new TextureBrush(img))
                    {
                        g.FillPath(tb, p);
                    }
                }
                return;
            }
            using (SolidBrush b = new SolidBrush(AvatarColor(name)))
            {
                g.FillEllipse(b, r);
            }
            string ini = Initial(name);
            Font f = Ui.F(Math.Max(8f, r.Height * 0.40f / Math.Max(0.6f, Ui.K)), true);
            Size sz = TextRenderer.MeasureText(ini, f, Size.Empty, TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, ini, f,
                new Rectangle(r.X + (r.Width - sz.Width) / 2, r.Y + (r.Height - sz.Height) / 2, sz.Width + 2, sz.Height),
                Color.White, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        }
    }

    /// <summary>扁平按钮：Primary / Soft / Ghost / Danger / Link</summary>
    internal enum ButtonKind { Primary, Soft, Ghost, Danger, Link }

    internal sealed class FlatButton : Control
    {
        public ButtonKind Kind = ButtonKind.Primary;
        public int Radius = 8;
        private bool hover;
        private bool down;

        public FlatButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            Font = Ui.F(9f);
            TabStop = false;
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { down = true; Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(0, 0, Width, Height);
            Color fill = Color.Transparent;
            Color fg = Theme.Text;
            Color border = Color.Empty;

            switch (Kind)
            {
                case ButtonKind.Primary:
                    fill = !Enabled ? Color.FromArgb(180, 198, 240) : (down ? Theme.AccentDark : (hover ? Color.FromArgb(58, 117, 255) : Theme.Accent));
                    fg = Color.White;
                    break;
                case ButtonKind.Soft:
                    fill = !Enabled ? Color.FromArgb(240, 243, 250) : (down ? Color.FromArgb(220, 231, 252) : (hover ? Color.FromArgb(226, 236, 255) : Theme.AccentSoft));
                    fg = Enabled ? Theme.Accent : Theme.Faint;
                    break;
                case ButtonKind.Ghost:
                    fill = down ? Color.FromArgb(233, 237, 245) : (hover ? Theme.Hover : Color.Transparent);
                    fg = Enabled ? Theme.Text : Theme.Faint;
                    border = Color.FromArgb(226, 230, 239);
                    break;
                case ButtonKind.Danger:
                    fill = hover ? Color.FromArgb(253, 240, 240) : Color.Transparent;
                    fg = Theme.Red;
                    break;
                case ButtonKind.Link:
                    fg = hover ? Theme.AccentDark : Theme.Accent;
                    break;
            }

            if (fill != Color.Transparent) Ui.FillRound(g, r, Radius, fill);
            if (!border.IsEmpty) Ui.StrokeRound(g, r, Radius, border, 1f);
            if (Kind == ButtonKind.Link && hover)
            {
                Size sz = Ui.Measure(Text, Font);
                int y = (Height + sz.Height) / 2 - 1;
                using (Pen pen = new Pen(Theme.Accent))
                {
                    g.DrawLine(pen, (Width - sz.Width) / 2, y, (Width + sz.Width) / 2, y);
                }
            }

            TextRenderer.DrawText(g, Text, Font, r, fg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
        }
    }

    /// <summary>
    /// 输入框：圆角边框 + 内嵌无边框 TextBox。
    /// 单行用 EM_SETCUEBANNER 显示占位符，多行用覆盖 Label。
    /// </summary>
    internal sealed class TextField : Panel
    {
        [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);

        private const int EM_SETCUEBANNER = 0x1501;

        public readonly TextBox Box;
        public string Placeholder = "";
        public bool Multiline;
        public int Radius = 9;
        private bool focused;
        private Label overlay;

        public TextField(bool multiline)
        {
            Multiline = multiline;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface;

            Box = new TextBox();
            Box.BorderStyle = BorderStyle.None;
            Box.Font = Ui.F(9.5f);
            Box.BackColor = Theme.Surface;
            Box.ForeColor = Theme.Text;
            Box.Multiline = multiline;
            if (multiline)
            {
                Box.ScrollBars = ScrollBars.Vertical;
                Box.AcceptsTab = false;
            }
            Box.GotFocus += delegate { focused = true; if (overlay != null) overlay.Visible = false; Invalidate(); };
            Box.LostFocus += delegate { focused = false; UpdateOverlay(); Invalidate(); };
            Box.TextChanged += delegate { UpdateOverlay(); };
            Controls.Add(Box);

            if (multiline)
            {
                overlay = new Label();
                overlay.AutoSize = false;
                overlay.ForeColor = Theme.Faint;
                overlay.BackColor = Theme.Surface;
                overlay.Font = Ui.F(9.5f);
                overlay.Cursor = Cursors.IBeam;
                overlay.Click += delegate { Box.Focus(); };
                Controls.Add(overlay);
                overlay.BringToFront();
            }
            Height = Ui.S(multiline ? 84 : 40);
        }

        public string Value
        {
            get { return Box.Text; }
            set { Box.Text = value ?? ""; }
        }

        public void SetPlaceholder(string text)
        {
            Placeholder = text;
            if (overlay != null)
            {
                overlay.Text = text;
                UpdateOverlay();
            }
            else if (!Multiline && Box.IsHandleCreated && !string.IsNullOrEmpty(text))
            {
                SendMessage(Box.Handle, EM_SETCUEBANNER, (IntPtr)1, text);
            }
        }

        private void UpdateOverlay()
        {
            if (overlay == null) return;
            overlay.Visible = !focused && Box.Text.Length == 0;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!Multiline && !string.IsNullOrEmpty(Placeholder))
            {
                SendMessage(Box.Handle, EM_SETCUEBANNER, (IntPtr)1, Placeholder);
            }
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (Box == null) return;
            int pad = Ui.S(12);
            int top = Ui.S(Multiline ? 10 : 9);
            Box.SetBounds(pad, top, Math.Max(10, Width - pad * 2), Math.Max(16, Height - top * 2));
            if (overlay != null)
            {
                overlay.SetBounds(pad + 2, top + 1, Math.Max(10, Width - pad * 2 - 4), Ui.S(20));
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Color border = focused ? Theme.Accent : Theme.Border;
            Ui.StrokeRound(g, new Rectangle(0, 0, Width, Height), Radius, border, focused ? 1.6f : 1f);
        }
    }

    /// <summary>圆形头像控件</summary>
    internal sealed class AvatarBox : Control
    {
        public string User = "";
        public string DataUrl = "";
        public int Ring;

        public AvatarBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Rectangle r = new Rectangle(0, 0, Width, Height);
            Image img = AvatarCache.Get(User, DataUrl, Math.Max(8, Width));
            Ui.DrawAvatar(g, r, img, User);
            if (Ring > 0)
            {
                using (Pen pen = new Pen(Color.White, Ui.S(Ring)))
                {
                    g.DrawEllipse(pen, new Rectangle(r.X + Ring / 2, r.Y + Ring / 2, r.Width - Ring, r.Height - Ring));
                }
            }
        }
    }

    /// <summary>右下角浮出的轻提示</summary>
    internal sealed class ToastBox : Control
    {
        private readonly Timer timer = new Timer();
        private string text = "";
        private int tick;

        public ToastBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Visible = false;
            timer.Interval = 1000;
            timer.Tick += delegate
            {
                tick++;
                if (tick >= 3)
                {
                    timer.Stop();
                    Visible = false;
                }
            };
        }

        public void Show(string message)
        {
            text = message ?? "";
            if (text.Length == 0) return;
            Width = Math.Min(Ui.S(520), Math.Max(Ui.S(160), Ui.Measure(text, Ui.F(9f)).Width + Ui.S(36)));
            Height = Ui.S(40);
            tick = 0;
            Visible = true;
            BringToFront();
            timer.Stop();
            timer.Start();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(0, 0, Width, Height);
            Ui.FillRound(g, r, Ui.S(8), Color.FromArgb(38, 44, 58));
            TextRenderer.DrawText(g, text, Ui.F(9f), r, Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
        }

        protected override void OnClick(EventArgs e)
        {
            timer.Stop();
            Visible = false;
            base.OnClick(e);
        }
    }

    /// <summary>输入一行/一段文字的对话框</summary>
    internal sealed class PromptBox : Form
    {
        private readonly TextField field;

        private PromptBox(string title, string label, string initial, bool multiline)
        {
            Text = title;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            BackColor = Theme.Surface;
            Font = Ui.F(9f);
            ClientSize = new Size(Ui.S(420), Ui.S(multiline ? 240 : 168));

            Label lbl = new Label();
            lbl.Text = label;
            lbl.ForeColor = Theme.Muted;
            lbl.AutoSize = true;
            lbl.Location = new Point(Ui.S(20), Ui.S(18));
            Controls.Add(lbl);

            field = new TextField(multiline);
            field.Value = initial ?? "";
            field.SetPlaceholder(label);
            field.SetBounds(Ui.S(20), Ui.S(42), ClientSize.Width - Ui.S(40), Ui.S(multiline ? 110 : 40));
            Controls.Add(field);

            Button ok = Make("确定", Theme.Accent, Color.White);
            ok.DialogResult = DialogResult.OK;
            ok.SetBounds(ClientSize.Width - Ui.S(180), ClientSize.Height - Ui.S(52), Ui.S(76), Ui.S(34));
            Controls.Add(ok);

            Button cancel = Make("取消", Color.FromArgb(240, 243, 249), Theme.Text);
            cancel.DialogResult = DialogResult.Cancel;
            cancel.SetBounds(ClientSize.Width - Ui.S(96), ClientSize.Height - Ui.S(52), Ui.S(76), Ui.S(34));
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
            Shown += delegate { field.Box.Focus(); };
        }

        private static Button Make(string text, Color back, Color fore)
        {
            Button b = new Button();
            b.Text = text;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 0;
            b.BackColor = back;
            b.ForeColor = fore;
            b.Cursor = Cursors.Hand;
            b.Font = Ui.F(9f);
            return b;
        }

        public static string Ask(IWin32Window owner, string title, string label, string initial)
        {
            using (PromptBox f = new PromptBox(title, label, initial, false))
            {
                if (f.ShowDialog(owner) != DialogResult.OK) return null;
                string v = f.field.Value.Trim();
                return v.Length == 0 ? null : v;
            }
        }

        public static string AskLong(IWin32Window owner, string title, string label, string initial)
        {
            using (PromptBox f = new PromptBox(title, label, initial, true))
            {
                if (f.ShowDialog(owner) != DialogResult.OK) return null;
                string v = f.field.Value.Trim();
                return v.Length == 0 ? null : v;
            }
        }
    }
}
