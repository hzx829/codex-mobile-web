// Icon artwork for the tray app, drawn in code so the .exe needs no binary assets.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

static class Logo {
  static readonly Color Ink = Color.FromArgb(17, 17, 17);

  // Same artwork as web/public/icon.svg (192 unit canvas), with an optional status dot.
  public static void Draw(Graphics g, int size, Color dot) {
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.Clear(Color.Transparent);
    float s = size / 192f;
    using (GraphicsPath path = Rounded(new RectangleF(0, 0, size, size), 44 * s))
    using (SolidBrush brush = new SolidBrush(Ink)) g.FillPath(brush, path);
    using (Pen pen = new Pen(Color.White, Math.Max(12 * s, 1.75f))) {
      pen.StartCap = LineCap.Round;
      pen.EndCap = LineCap.Round;
      pen.LineJoin = LineJoin.Round;
      g.DrawLines(pen, new[] {P(73, 62, s), P(40, 96, s), P(73, 130, s)});
      g.DrawLines(pen, new[] {P(119, 62, s), P(152, 96, s), P(119, 130, s)});
    }
    if (dot.IsEmpty) return;
    float d = size * 0.4f, ring = Math.Max(size * 0.07f, 1f);
    using (SolidBrush brush = new SolidBrush(Ink)) g.FillEllipse(brush, size - d - ring, size - d - ring, d + ring * 2, d + ring * 2);
    using (SolidBrush brush = new SolidBrush(dot)) g.FillEllipse(brush, size - d, size - d, d - 0.5f, d - 0.5f);
  }

  public static Icon Create(int size, Color dot) {
    using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bitmap)) Draw(g, size, dot);
      return Icon.FromHandle(bitmap.GetHicon());
    }
  }

  // Writes a multi-size .ico (PNG entries) used as the executable's own icon.
  public static void WriteIco(string path) {
    int[] sizes = {16, 20, 24, 32, 40, 48, 64, 256};
    List<byte[]> images = new List<byte[]>();
    foreach (int size in sizes) {
      using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
      using (MemoryStream stream = new MemoryStream()) {
        using (Graphics g = Graphics.FromImage(bitmap)) Draw(g, size, Color.Empty);
        bitmap.Save(stream, ImageFormat.Png);
        images.Add(stream.ToArray());
      }
    }
    using (BinaryWriter writer = new BinaryWriter(File.Create(path))) {
      writer.Write((short)0);
      writer.Write((short)1);
      writer.Write((short)sizes.Length);
      int offset = 6 + 16 * sizes.Length;
      for (int i = 0; i < sizes.Length; i++) {
        byte edge = (byte)(sizes[i] >= 256 ? 0 : sizes[i]);
        writer.Write(edge);
        writer.Write(edge);
        writer.Write((byte)0);
        writer.Write((byte)0);
        writer.Write((short)1);
        writer.Write((short)32);
        writer.Write(images[i].Length);
        writer.Write(offset);
        offset += images[i].Length;
      }
      foreach (byte[] image in images) writer.Write(image);
    }
  }

  static PointF P(float x, float y, float s) {return new PointF(x * s, y * s);}

  static GraphicsPath Rounded(RectangleF r, float radius) {
    float d = radius * 2;
    GraphicsPath path = new GraphicsPath();
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }
}
