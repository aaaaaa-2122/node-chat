using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace NodeChat
{
    /// <summary>大图查看：滚轮缩放、拖拽平移、另存 / 复制</summary>
    internal sealed class ImageViewer : Form
    {
        private readonly Image image;
        private readonly string dataUrl;
        private float zoom = 1f;
        private Point offset = Point.Empty;
        private bool dragging;
        private Point dragStart;

        public ImageViewer(Image img, string dataUrl)
        {
            this.image = img;
            this.dataUrl = dataUrl;

            Text = "查看图片";
            StartPosition = FormStartPosition.CenterParent;
            BackColor = Color.FromArgb(24, 27, 34);
            MinimizeBox = false;
            ShowInTaskbar = false;
            KeyPreview = true;
            DoubleBuffered = true;

            int w = Math.Min(img.Width + Ui.S(80), Ui.S(960));
            int h = Math.Min(img.Height + Ui.S(120), Ui.S(760));
            ClientSize = new Size(Math.Max(w, Ui.S(480)), Math.Max(h, Ui.S(360)));

            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

            Panel bar = new Panel();
            bar.Height = Ui.S(48);
            bar.Dock = DockStyle.Bottom;
            bar.BackColor = Color.FromArgb(32, 36, 45);
            Controls.Add(bar);

            Label hint = new Label();
            hint.Text = "滚轮缩放 · 拖动平移 · Esc 关闭";
            hint.ForeColor = Color.FromArgb(160, 168, 184);
            hint.Font = Ui.F(8.2f);
            hint.AutoSize = true;
            hint.BackColor = Color.Transparent;
            hint.Location = new Point(Ui.S(16), Ui.S(15));
            bar.Controls.Add(hint);

            Button save = new Button();
            save.Text = "另存为…";
            save.FlatStyle = FlatStyle.Flat;
            save.FlatAppearance.BorderColor = Color.FromArgb(70, 76, 90);
            save.BackColor = Color.FromArgb(44, 49, 60);
            save.ForeColor = Color.White;
            save.Font = Ui.F(8.5f);
            save.Cursor = Cursors.Hand;
            save.SetBounds(bar.Width - Ui.S(190), Ui.S(9), Ui.S(86), Ui.S(30));
            save.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            save.Click += delegate { SaveAs(); };
            bar.Controls.Add(save);

            Button copy = new Button();
            copy.Text = "复制";
            copy.FlatStyle = FlatStyle.Flat;
            copy.FlatAppearance.BorderColor = Color.FromArgb(70, 76, 90);
            copy.BackColor = Color.FromArgb(44, 49, 60);
            copy.ForeColor = Color.White;
            copy.Font = Ui.F(8.5f);
            copy.Cursor = Cursors.Hand;
            copy.SetBounds(bar.Width - Ui.S(96), Ui.S(9), Ui.S(80), Ui.S(30));
            copy.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            copy.Click += delegate
            {
                try { Clipboard.SetImage(image); }
                catch (Exception ex) { MessageBox.Show(this, ex.Message, "复制失败"); }
            };
            bar.Controls.Add(copy);

            MouseWheel += delegate (object s, MouseEventArgs e)
            {
                float next = zoom * (e.Delta > 0 ? 1.12f : 0.89f);
                zoom = Math.Max(0.12f, Math.Min(8f, next));
                Invalidate();
            };
            MouseDown += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) { dragging = true; dragStart = e.Location; Cursor = Cursors.SizeAll; }
            };
            MouseMove += delegate (object s, MouseEventArgs e)
            {
                if (!dragging) return;
                offset.X += e.X - dragStart.X;
                offset.Y += e.Y - dragStart.Y;
                dragStart = e.Location;
                Invalidate();
            };
            MouseUp += delegate { dragging = false; Cursor = Cursors.Default; };
            DoubleClick += delegate { zoom = 1f; offset = Point.Empty; Invalidate(); };
            KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) Close();
            };
            Shown += delegate { ActiveControl = null; };
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.Clear(Color.FromArgb(24, 27, 34));

            int availH = ClientSize.Height - Ui.S(48);
            float fit = Math.Min((float)(ClientSize.Width - Ui.S(40)) / image.Width, (float)(availH - Ui.S(40)) / image.Height);
            float scale = Math.Max(0.05f, Math.Min(1f, fit)) * zoom;
            int w = (int)(image.Width * scale);
            int h = (int)(image.Height * scale);
            int x = (ClientSize.Width - w) / 2 + offset.X;
            int y = (availH - h) / 2 + offset.Y;

            using (SolidBrush shadow = new SolidBrush(Color.FromArgb(60, 0, 0, 0)))
            {
                g.FillRectangle(shadow, x + 6, y + 8, w, h);
            }
            g.DrawImage(image, new Rectangle(x, y, w, h));
        }

        private void SaveAs()
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
                        using (Bitmap bmp = new Bitmap(image.Width, image.Height))
                        {
                            using (Graphics g = Graphics.FromImage(bmp))
                            {
                                g.Clear(Color.White);
                                g.DrawImage(image, 0, 0, image.Width, image.Height);
                            }
                            bmp.Save(dlg.FileName, System.Drawing.Imaging.ImageFormat.Jpeg);
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
