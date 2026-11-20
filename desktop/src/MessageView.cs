using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace NodeChat
{
    internal sealed class ChatMessage
    {
        public string Id = "";
        public string Kind = "group";      // group | dm | system
        public string Room = "";
        public string From = "";
        public string To = "";
        public string Text = "";
        public string Image = "";
        public string Event = "";
        public long Ts;
        public bool Self;
        public bool IsSystem;
        public bool IsAnnouncement;
        public bool Offline;

        public bool IsPrivate { get { return Kind == "dm"; } }
    }

    /// <summary>聊天图片解码缓存（避免滚动时反复 base64 解码）</summary>
    internal static class ImageCache
    {
        private static readonly Dictionary<string, Image> map = new Dictionary<string, Image>();
        private static readonly Queue<string> order = new Queue<string>();

        public static Image Get(string dataUrl)
        {
            if (string.IsNullOrEmpty(dataUrl)) return null;
            string key = dataUrl.Length + ":" + dataUrl.GetHashCode().ToString();
            Image img;
            if (map.TryGetValue(key, out img)) return img;
            img = ImageTools.FromDataUrl(dataUrl, 720, 720);
            map[key] = img;
            order.Enqueue(key);
            while (order.Count > 120)
            {
                string old = order.Dequeue();
                Image dead;
                if (map.TryGetValue(old, out dead) && old != key)
                {
                    map.Remove(old);
                    if (dead != null) { try { dead.Dispose(); } catch { } }
                }
            }
            return img;
        }
    }

    /// <summary>
    /// 消息视图：自绘气泡、头像、图片、日期分隔与系统公告，支持滚轮 / 拖动滚动条 /
    /// 点击图片查看大图 / 右键复制。
    /// </summary>
    internal sealed class MessageView : Control
    {
        public string Me = "";
        public readonly List<ChatMessage> Messages = new List<ChatMessage>();
        public Func<string, string> AvatarUrl;
        public event EventHandler<string> ImageActivated;
        public event EventHandler<string> AvatarActivated;

        private sealed class Row
        {
            public ChatMessage M;
            public int Top;
            public int Height;
            public bool Day;
            public string DayText = "";
            public bool System;
            public Rectangle Avatar;
            public Rectangle Bubble;
            public Rectangle Img;
            public Rectangle Text;
            public Rectangle Pill;
        }

        private readonly List<Row> rows = new List<Row>();
        private int contentHeight;
        private int scroll;
        private bool stick = true;
        private bool dragging;
        private int dragY;
        private int dragScroll;
        private int hoverRow = -1;
        private int hoverImage = -1;

        public MessageView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Bg;
            Font = Ui.F(9.5f);
        }

        // ------------------------------------------------------------ 数据操作
        public void SetMessages(List<ChatMessage> list)
        {
            Messages.Clear();
            if (list != null) Messages.AddRange(list);
            Sort();
            Relayout();
            scroll = Math.Max(0, contentHeight - Height);
            stick = true;
            Invalidate();
        }

        public void Add(ChatMessage m)
        {
            if (m == null) return;
            Messages.Add(m);
            Sort();
            bool atBottom = stick || scroll >= MaxScroll - Ui.S(6);
            Relayout();
            if (atBottom)
            {
                scroll = MaxScroll;
                stick = true;
            }
            Invalidate();
        }

        public void UpdateLast()
        {
            Relayout();
            if (stick) scroll = MaxScroll;
            Invalidate();
        }

        public void Clear()
        {
            Messages.Clear();
            rows.Clear();
            contentHeight = 0;
            scroll = 0;
            stick = true;
            Invalidate();
        }

        private void Sort()
        {
            Messages.Sort(delegate (ChatMessage a, ChatMessage b)
            {
                int c = a.Ts.CompareTo(b.Ts);
                if (c != 0) return c;
                return string.CompareOrdinal(a.Id, b.Id);
            });
        }

        public void ScrollToEnd()
        {
            scroll = MaxScroll;
            stick = true;
            Invalidate();
        }

        private int MaxScroll { get { return Math.Max(0, contentHeight - Height); } }

        // -------------------------------------------------------------- 布局
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            bool atBottom = stick;
            Relayout();
            if (atBottom) scroll = MaxScroll;
            Invalidate();
        }

        public void Relayout()
        {
            rows.Clear();
            int padL = Ui.S(26);
            int padR = Ui.S(26) + Ui.S(10);
            int w = Math.Max(Ui.S(240), Width - padL - padR);
            int avatarSize = Ui.S(36);
            int gap = Ui.S(11);
            int maxBubble = Math.Min(Ui.S(560), (int)(Math.Max(Ui.S(160), w - avatarSize - gap) * 0.74));
            int y = Ui.S(18);
            long prevTs = 0;
            Font textFont = Ui.F(9.5f);
            int padX = Ui.S(13);
            int padY = Ui.S(10);

            foreach (ChatMessage m in Messages)
            {
                if (!m.IsSystem && prevTs > 0 && !Ui.SameDay(prevTs, m.Ts))
                {
                    Row day = new Row();
                    day.Day = true;
                    day.M = m;
                    day.DayText = Ui.DayLabel(m.Ts);
                    day.Top = y;
                    day.Height = Ui.S(34);
                    rows.Add(day);
                    y += day.Height;
                }
                prevTs = m.Ts;

                if (m.IsSystem)
                {
                    string txt = m.Text;
                    if (m.IsAnnouncement) txt = "公告 · " + txt;
                    Size sz = Ui.Measure(txt, Ui.F(8.5f), Math.Min(maxBubble + Ui.S(80), (int)(w * 0.78)));
                    int pw = Math.Min(w - Ui.S(20), sz.Width + Ui.S(26));
                    int ph = sz.Height + Ui.S(16);
                    Row sr = new Row();
                    sr.M = m;
                    sr.System = true;
                    sr.Top = y;
                    sr.Height = ph + Ui.S(14);
                    sr.Pill = new Rectangle((Width - pw) / 2, y, pw, ph);
                    sr.Text = new Rectangle(sr.Pill.X + Ui.S(13), sr.Pill.Y + Ui.S(8), pw - Ui.S(26), ph - Ui.S(16));
                    rows.Add(sr);
                    y += sr.Height;
                    continue;
                }

                // 文本 / 图片尺寸
                int imgW = 0, imgH = 0;
                Image img = null;
                if (!string.IsNullOrEmpty(m.Image))
                {
                    img = ImageCache.Get(m.Image);
                    if (img != null)
                    {
                        double maxW = Math.Min(Ui.S(260), maxBubble - Ui.S(10));
                        double maxH = Ui.S(220);
                        double k = Math.Min(1.0, Math.Min(maxW / img.Width, maxH / img.Height));
                        imgW = (int)Math.Round(img.Width * k);
                        imgH = (int)Math.Round(img.Height * k);
                    }
                }

                int textW = 0, textH = 0;
                if (!string.IsNullOrEmpty(m.Text))
                {
                    Size ts = Ui.Measure(m.Text, textFont, maxBubble - padX * 2);
                    textW = ts.Width;
                    textH = ts.Height;
                }

                int innerW = Math.Max(imgW, textW);
                int bubbleW = innerW + padX * 2;
                int bubbleH = padY * 2 + textH + imgH + (textH > 0 && imgH > 0 ? Ui.S(8) : 0);

                int nameH = Ui.S(19);
                int rightEdge = Width - padR;

                Row r = new Row();
                r.M = m;
                r.Top = y;
                r.Height = nameH + bubbleH + Ui.S(14);
                int bubbleX = m.Self
                    ? (rightEdge - avatarSize - gap - bubbleW)
                    : (padL + avatarSize + gap);
                int bubbleY = y + nameH;
                r.Bubble = new Rectangle(bubbleX, bubbleY, bubbleW, bubbleH);
                r.Avatar = m.Self
                    ? new Rectangle(rightEdge - avatarSize, bubbleY, avatarSize, avatarSize)
                    : new Rectangle(padL, bubbleY, avatarSize, avatarSize);
                if (imgH > 0) r.Img = new Rectangle(bubbleX + padX, bubbleY + padY, imgW, imgH);
                if (textH > 0)
                {
                    int ty = bubbleY + padY + (imgH > 0 ? imgH + Ui.S(8) : 0);
                    r.Text = new Rectangle(bubbleX + padX, ty, textW + 2, textH);
                }
                rows.Add(r);
                y += r.Height;
            }

            contentHeight = y + Ui.S(14);
            // 消息不多时贴着输入框底部显示（和主流聊天工具一致）
            if (contentHeight < Height && rows.Count > 0)
            {
                int delta = Height - contentHeight;
                foreach (Row r in rows) ShiftRow(r, delta);
                contentHeight = Height;
            }
            if (scroll > MaxScroll) scroll = MaxScroll;
        }

        private static void ShiftRow(Row r, int dy)
        {
            r.Top += dy;
            r.Avatar.Y += dy;
            r.Bubble.Y += dy;
            r.Img.Y += dy;
            r.Text.Y += dy;
            r.Pill.Y += dy;
        }

        // -------------------------------------------------------------- 绘制
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.Bg);
            if (Messages.Count == 0)
            {
                DrawEmpty(g);
                return;
            }

            Region clip = g.Clip;
            g.SetClip(ClientRectangle);

            foreach (Row r in rows)
            {
                int top = r.Top - scroll;
                if (top + r.Height < -10 || top > Height + 10) continue;

                if (r.Day)
                {
                    TextRenderer.DrawText(g, r.DayText, Ui.F(8f),
                        new Rectangle(0, top + Ui.S(6), Width, Ui.S(22)), Theme.Faint,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
                    continue;
                }

                if (r.System)
                {
                    Rectangle pill = new Rectangle(r.Pill.X, r.Pill.Y - scroll, r.Pill.Width, r.Pill.Height);
                    Ui.FillRound(g, pill, Ui.S(9), r.M.IsAnnouncement ? Color.FromArgb(232, 240, 255) : Color.FromArgb(233, 237, 244));
                    Color fg = r.M.IsAnnouncement ? Color.FromArgb(37, 84, 190) : Color.FromArgb(112, 121, 140);
                    Ui.Draw(g, r.M.Text, Ui.F(8.5f), fg,
                        new Rectangle(pill.X + Ui.S(13), pill.Y + Ui.S(8), pill.Width - Ui.S(26), pill.Height - Ui.S(16)));
                    if (r.M.IsAnnouncement)
                    {
                        // 左侧小竖条强调公告
                        using (SolidBrush b = new SolidBrush(Theme.Accent))
                        {
                            g.FillRectangle(b, new Rectangle(pill.X + Ui.S(4), pill.Y + Ui.S(8), Ui.S(3), pill.Height - Ui.S(16)));
                        }
                    }
                    continue;
                }

                Rectangle av = new Rectangle(r.Avatar.X, r.Avatar.Y - scroll, r.Avatar.Width, r.Avatar.Height);
                string user = r.M.Self ? Me : r.M.From;
                string url = AvatarUrl != null ? AvatarUrl(user) : "";
                Image avatar = AvatarCache.Get(user, url, av.Width);
                Ui.DrawAvatar(g, av, avatar, user);

                Rectangle bubble = new Rectangle(r.Bubble.X, r.Bubble.Y - scroll, r.Bubble.Width, r.Bubble.Height);

                if (r.M.Self)
                {
                    Ui.FillRound(g, bubble, Ui.S(12), Theme.SelfBubble);
                }
                else
                {
                    Ui.FillRound(g, bubble, Ui.S(12), Theme.BubbleOther);
                    Ui.StrokeRound(g, bubble, Ui.S(12), Color.FromArgb(231, 234, 243), 1f);
                }

                if (!r.Img.IsEmpty)
                {
                    Rectangle ir = new Rectangle(r.Img.X, r.Img.Y - scroll, r.Img.Width, r.Img.Height);
                    Image img = ImageCache.Get(r.M.Image);
                    if (img != null)
                    {
                        using (GraphicsPath path = Ui.Round(ir, Ui.S(9)))
                        {
                            Region old = g.Clip;
                            g.SetClip(path, CombineMode.Intersect);
                            g.DrawImage(img, ir);
                            g.Clip = old;
                        }
                        using (Pen pen = new Pen(Color.FromArgb(40, 0, 0, 0)))
                        {
                            using (GraphicsPath path = Ui.Round(ir, Ui.S(9))) g.DrawPath(pen, path);
                        }
                    }
                }

                if (!r.Text.IsEmpty)
                {
                    Rectangle tr = new Rectangle(r.Text.X, r.Text.Y - scroll, r.Text.Width, r.Text.Height);
                    Color tc = r.M.Self ? Color.White : Theme.Text;
                    TextRenderer.DrawText(g, r.M.Text, Ui.F(9.5f), tr, tc, Ui.WrapFlags);
                }

                // 昵称 + 时间
                string name = r.M.Self ? "我" : r.M.From;
                string time = Ui.Hm(r.M.Ts) + (r.M.Offline ? " · 离线留言" : "");
                Font nf = Ui.F(8.5f, !r.M.Self);
                Color nc = r.M.Self ? Color.FromArgb(150, 160, 180) : Color.FromArgb(120, 129, 149);
                if (r.M.Self)
                {
                    Size tsz = Ui.Measure(time, Ui.F(8f));
                    TextRenderer.DrawText(g, time, Ui.F(8f),
                        new Rectangle(bubble.Right - tsz.Width - Ui.S(2), bubble.Top - Ui.S(20), tsz.Width + 4, Ui.S(18)),
                        nc, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.Right);
                }
                else
                {
                    Size nsz = Ui.Measure(name, nf);
                    TextRenderer.DrawText(g, name, nf,
                        new Rectangle(bubble.X, bubble.Top - Ui.S(20), Math.Max(Ui.S(30), nsz.Width + 4), Ui.S(18)),
                        nc, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                    TextRenderer.DrawText(g, time, Ui.F(8f),
                        new Rectangle(bubble.X + nsz.Width + Ui.S(8), bubble.Top - Ui.S(20), Ui.S(140), Ui.S(18)),
                        Color.FromArgb(160, 167, 182), TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                }
            }

            g.Clip = clip;
            DrawScrollbar(g);
        }

        private void DrawEmpty(Graphics g)
        {
            int cx = Width / 2;
            int cy = Height / 2 - Ui.S(20);
            int size = Ui.S(64);
            Rectangle box = new Rectangle(cx - size / 2, cy - size, size, size);
            Ui.FillRound(g, box, Ui.S(18), Color.FromArgb(232, 237, 247));
            using (Pen pen = new Pen(Color.FromArgb(176, 187, 208), Ui.S(2)))
            {
                Rectangle b2 = new Rectangle(box.X + Ui.S(17), box.Y + Ui.S(20), box.Width - Ui.S(34), box.Height - Ui.S(38));
                Ui.StrokeRound(g, b2, Ui.S(9), Color.FromArgb(176, 187, 208), Ui.S(2));
                g.DrawLine(pen, b2.X + Ui.S(8), b2.Bottom - 1, b2.X + Ui.S(8), b2.Bottom + Ui.S(8));
            }
            TextRenderer.DrawText(g, "还没有消息", Ui.F(11f, true),
                new Rectangle(0, cy + Ui.S(16), Width, Ui.S(26)), Color.FromArgb(120, 129, 149),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
            TextRenderer.DrawText(g, "从下面输入第一条消息吧", Ui.F(9f),
                new Rectangle(0, cy + Ui.S(44), Width, Ui.S(24)), Theme.Faint,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
        }

        private void DrawScrollbar(Graphics g)
        {
            if (contentHeight <= Height || Height <= 0) return;
            int track = Height - Ui.S(10);
            int thumb = Math.Max(Ui.S(36), (int)((double)Height / contentHeight * track));
            int max = Math.Max(1, contentHeight - Height);
            int top = Ui.S(5) + (int)((double)scroll / max * (track - thumb));
            Rectangle tr = new Rectangle(Width - Ui.S(8), top, Ui.S(5), thumb);
            Ui.FillRound(g, tr, Ui.S(3), Color.FromArgb(206, 213, 226));
        }

        // -------------------------------------------------------------- 交互
        private int RowAt(int contentY)
        {
            for (int i = 0; i < rows.Count; i++)
            {
                Row r = rows[i];
                if (contentY >= r.Top && contentY < r.Top + r.Height) return i;
            }
            return -1;
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            scroll -= Math.Sign(e.Delta) * Ui.S(110);
            if (scroll < 0) scroll = 0;
            if (scroll > MaxScroll) scroll = MaxScroll;
            stick = scroll >= MaxScroll - Ui.S(6);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
            {
                int track = Height - Ui.S(10);
                int thumb = Math.Max(Ui.S(36), (int)((double)Height / contentHeight * track));
                int span = Math.Max(1, track - thumb);
                int delta = e.Y - dragY;
                int max = Math.Max(1, contentHeight - Height);
                scroll = dragScroll + (int)((double)delta / span * max);
                if (scroll < 0) scroll = 0;
                if (scroll > MaxScroll) scroll = MaxScroll;
                stick = scroll >= MaxScroll - Ui.S(6);
                Invalidate();
                return;
            }

            int idx = RowAt(e.Y + scroll);
            int imgIdx = -1;
            if (idx >= 0 && rows[idx].M != null && !rows[idx].Img.IsEmpty)
            {
                Rectangle ir = rows[idx].Img;
                Point p = new Point(e.X, e.Y + scroll);
                if (ir.Contains(p)) imgIdx = idx;
            }
            if (idx != hoverRow || imgIdx != hoverImage)
            {
                hoverRow = idx;
                hoverImage = imgIdx;
                Cursor = imgIdx >= 0 ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hoverRow != -1 || hoverImage != -1)
            {
                hoverRow = -1;
                hoverImage = -1;
                Cursor = Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && contentHeight > Height && e.X >= Width - Ui.S(12))
            {
                dragging = true;
                dragY = e.Y;
                dragScroll = scroll;
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            dragging = false;
            if (e.Button != MouseButtons.Left) return;

            int idx = RowAt(e.Y + scroll);
            if (idx < 0) return;
            Row r = rows[idx];
            if (r.M == null) return;
            Point p = new Point(e.X, e.Y + scroll);
            if (!r.Img.IsEmpty && r.Img.Contains(p))
            {
                if (ImageActivated != null) ImageActivated(this, r.M.Image);
                return;
            }
            if (r.Avatar.Contains(p) && !r.M.Self && !r.M.IsSystem)
            {
                if (AvatarActivated != null) AvatarActivated(this, r.M.From);
            }
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button != MouseButtons.Right) return;
            int idx = RowAt(e.Y + scroll);
            if (idx < 0) return;
            Row r = rows[idx];
            if (r.M == null) return;
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = Ui.F(9f);
            if (!string.IsNullOrEmpty(r.M.Text))
            {
                menu.Items.Add("复制文本", null, delegate { try { Clipboard.SetText(r.M.Text); } catch { } });
            }
            if (!r.Img.IsEmpty)
            {
                menu.Items.Add("另存图片…", null, delegate { SaveImage(r.M.Image); });
                menu.Items.Add("复制图片", null, delegate
                {
                    Image img = ImageCache.Get(r.M.Image);
                    if (img != null) { try { Clipboard.SetImage(img); } catch { } }
                });
            }
            if (menu.Items.Count > 0) menu.Show(this, e.Location);
        }

        private void SaveImage(string dataUrl)
        {
            using (SaveFileDialog dlg = new SaveFileDialog())
            {
                dlg.Filter = "PNG 图片|*.png|JPEG 图片|*.jpg";
                dlg.FileName = "node-chat-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png";
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    if (dlg.FileName.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase))
                    {
                        using (Image img = ImageCache.Get(dataUrl))
                        {
                            if (img == null) throw new FormatException("图片已失效");
                            img.Save(dlg.FileName, System.Drawing.Imaging.ImageFormat.Jpeg);
                        }
                    }
                    else
                    {
                        ImageTools.SaveDataUrl(dataUrl, dlg.FileName);
                    }
                    MessageBox.Show(this, "图片已保存", "完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(this, ex.Message, "保存失败", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }
    }
}
