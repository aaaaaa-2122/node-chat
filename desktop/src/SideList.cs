using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace NodeChat
{
    internal sealed class SideItem
    {
        public string Kind = "room";      // header | room | dm | action | hint
        public string Key = "";
        public string Title = "";
        public string Sub = "";
        public int Badge;
        public bool Online;
        public bool Self;
        public string AvatarUser = "";
        public string AvatarUrl = "";
        public string Right = "";         // header 右侧的小字（如计数/加号）
    }

    /// <summary>
    /// 左侧会话列表：分组标题 + 头像行 + 未读角标，支持悬停/选中/滚轮。
    /// </summary>
    internal sealed class SideList : Control
    {
        public readonly List<SideItem> Items = new List<SideItem>();
        public string SelectedKey = "";
        public event EventHandler<SideItem> ItemClick;

        private int scroll;
        private int hover = -1;
        private int contentHeight;

        public SideList()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Sidebar;
            Font = Ui.F(9f);
        }

        public void SetItems(List<SideItem> items)
        {
            Items.Clear();
            Items.AddRange(items);
            ClampScroll();
            Invalidate();
        }

        private int RowH { get { return Ui.S(56); } }
        private int HeaderH { get { return Ui.S(36); } }

        private void Measure()
        {
            int y = Ui.S(4);
            foreach (SideItem it in Items)
            {
                y += it.Kind == "header" ? HeaderH : (it.Kind == "hint" ? Ui.S(30) : RowH);
            }
            contentHeight = y + Ui.S(8);
        }

        private int MaxScroll
        {
            get { return Math.Max(0, contentHeight - Height); }
        }

        private void ClampScroll()
        {
            Measure();
            if (scroll > MaxScroll) scroll = MaxScroll;
            if (scroll < 0) scroll = 0;
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ClampScroll();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            scroll -= Math.Sign(e.Delta) * Ui.S(120);
            ClampScroll();
            Invalidate();
            UpdateHover(e.Location);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            UpdateHover(e.Location);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hover != -1) { hover = -1; Invalidate(); }
            Cursor = Cursors.Default;
        }

        private void UpdateHover(Point p)
        {
            int idx = HitTest(p);
            if (idx != hover)
            {
                hover = idx;
                SideItem it = idx >= 0 ? Items[idx] : null;
                Cursor = it != null && it.Kind != "header" && it.Kind != "hint" ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        private List<Rectangle> rowRects = new List<Rectangle>();

        private void EnsureRects()
        {
            rowRects.Clear();
            int y = Ui.S(4) - scroll;
            foreach (SideItem it in Items)
            {
                int h = it.Kind == "header" ? HeaderH : (it.Kind == "hint" ? Ui.S(30) : RowH);
                rowRects.Add(new Rectangle(0, y, Width, h));
                y += h;
            }
        }

        private int HitTest(Point p)
        {
            EnsureRects();
            for (int i = 0; i < rowRects.Count; i++)
            {
                if (rowRects[i].Contains(p)) return i;
            }
            return -1;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            int idx = HitTest(e.Location);
            if (idx < 0) return;
            SideItem it = Items[idx];
            if (it.Kind == "header" || it.Kind == "hint") return;
            SelectedKey = it.Key;
            Invalidate();
            if (ItemClick != null) ItemClick(this, it);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Theme.Sidebar);
            EnsureRects();

            for (int i = 0; i < Items.Count; i++)
            {
                SideItem it = Items[i];
                Rectangle r = rowRects[i];
                if (r.Bottom < 0 || r.Top > Height) continue;

                if (it.Kind == "header")
                {
                    TextRenderer.DrawText(g, it.Title, Ui.F(8.5f, true),
                        new Rectangle(Ui.S(18), r.Top, Width - Ui.S(60), r.Height), Theme.Faint,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                    if (!string.IsNullOrEmpty(it.Right))
                    {
                        TextRenderer.DrawText(g, it.Right, Ui.F(8.5f),
                            new Rectangle(0, r.Top, Width - Ui.S(16), r.Height), Theme.Faint,
                            TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                    }
                    continue;
                }

                if (it.Kind == "hint")
                {
                    TextRenderer.DrawText(g, it.Title, Ui.F(8.5f),
                        new Rectangle(Ui.S(18), r.Top, Width - Ui.S(30), r.Height), Theme.Faint,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                    continue;
                }

                bool selected = it.Key.Length > 0 && it.Key == SelectedKey;
                if (selected)
                {
                    Rectangle bg = new Rectangle(Ui.S(8), r.Top + Ui.S(3), Width - Ui.S(16), r.Height - Ui.S(6));
                    Ui.FillRound(g, bg, Ui.S(9), Theme.AccentSoft);
                    using (SolidBrush b = new SolidBrush(Theme.Accent))
                    {
                        g.FillRectangle(b, new Rectangle(Ui.S(8), r.Top + Ui.S(12), Ui.S(3), r.Height - Ui.S(24)));
                    }
                }
                else if (i == hover)
                {
                    Rectangle bg = new Rectangle(Ui.S(8), r.Top + Ui.S(3), Width - Ui.S(16), r.Height - Ui.S(6));
                    Ui.FillRound(g, bg, Ui.S(9), Theme.Hover);
                }

                int avatarSize = Ui.S(36);
                int ax = Ui.S(20);
                int ay = r.Top + (r.Height - avatarSize) / 2;

                if (it.Kind == "action")
                {
                    Rectangle plus = new Rectangle(ax, ay, avatarSize, avatarSize);
                    Ui.FillRound(g, plus, Ui.S(10), Theme.AccentSoft);
                    using (Pen pen = new Pen(Theme.Accent, Ui.S(2)))
                    {
                        g.DrawLine(pen, plus.X + plus.Width / 2, plus.Y + Ui.S(11), plus.X + plus.Width / 2, plus.Bottom - Ui.S(11));
                        g.DrawLine(pen, plus.X + Ui.S(11), plus.Y + plus.Height / 2, plus.Right - Ui.S(11), plus.Y + plus.Height / 2);
                    }
                }
                else
                {
                    Rectangle av = new Rectangle(ax, ay, avatarSize, avatarSize);
                    Image img = AvatarCache.Get(it.AvatarUser.Length > 0 ? it.AvatarUser : it.Title, it.AvatarUrl, avatarSize);
                    Ui.DrawAvatar(g, av, img, it.AvatarUser.Length > 0 ? it.AvatarUser : it.Title);
                    if (it.Online)
                    {
                        int d = Ui.S(10);
                        Rectangle dot = new Rectangle(av.Right - d - Ui.S(1), av.Bottom - d - Ui.S(1), d, d);
                        using (SolidBrush b = new SolidBrush(Color.White)) g.FillEllipse(b, dot);
                        using (SolidBrush b = new SolidBrush(Theme.Green)) g.FillEllipse(b, new Rectangle(dot.X + 2, dot.Y + 2, d - 4, d - 4));
                    }
                }

                int textX = ax + avatarSize + Ui.S(12);
                int textW = Width - textX - Ui.S(18);
                bool hasSub = !string.IsNullOrEmpty(it.Sub);
                int titleY = hasSub ? r.Top + Ui.S(11) : r.Top + (r.Height - Ui.S(20)) / 2;

                Color titleColor = selected ? Theme.Accent : (it.Kind == "action" ? Theme.Accent : Theme.Text);
                TextRenderer.DrawText(g, it.Title, Ui.F(9.5f, selected || it.Kind == "action"),
                    new Rectangle(textX, titleY, textW - Ui.S(it.Badge > 0 ? 30 : 0), Ui.S(20)), titleColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

                if (hasSub)
                {
                    TextRenderer.DrawText(g, it.Sub, Ui.F(8.5f),
                        new Rectangle(textX, r.Top + Ui.S(31), textW - Ui.S(it.Badge > 0 ? 30 : 0), Ui.S(18)), Theme.Muted,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                }

                if (it.Badge > 0)
                {
                    string num = it.Badge > 99 ? "99+" : it.Badge.ToString();
                    Size sz = Ui.Measure(num, Ui.F(8f, true));
                    int bw = Math.Max(Ui.S(18), sz.Width + Ui.S(10));
                    Rectangle br = new Rectangle(Width - Ui.S(18) - bw, r.Top + (r.Height - Ui.S(18)) / 2, bw, Ui.S(18));
                    Ui.FillRound(g, br, Ui.S(9), Theme.Accent);
                    TextRenderer.DrawText(g, num, Ui.F(8f, true), br, Color.White,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                }
            }

            // 滚动条
            if (contentHeight > Height && Height > 0)
            {
                int track = Height - Ui.S(8);
                int thumb = Math.Max(Ui.S(28), (int)((double)Height / contentHeight * track));
                int top = Ui.S(4) + (int)((double)scroll / Math.Max(1, contentHeight - Height) * (track - thumb));
                Rectangle tr = new Rectangle(Width - Ui.S(6), top, Ui.S(4), thumb);
                Ui.FillRound(g, tr, Ui.S(2), Color.FromArgb(210, 216, 228));
            }
        }
    }
}
