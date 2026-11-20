using System;
using System.Drawing;
using System.Windows.Forms;

namespace NodeChat
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            try
            {
                using (Graphics g = Graphics.FromHwnd(IntPtr.Zero))
                {
                    Ui.K = Math.Max(1f, g.DpiX / 96f);
                }
            }
            catch { Ui.K = 1f; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate (object s, System.Threading.ThreadExceptionEventArgs e)
            {
                MessageBox.Show(e.Exception.Message, "Node Chat 出错了",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            Application.Run(new LoginForm());
        }
    }
}
