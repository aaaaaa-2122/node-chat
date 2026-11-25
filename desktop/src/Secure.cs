using System;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;

namespace NodeChat
{
    /// <summary>
    /// 与服务端 server/src/secure.js 完全兼容的加密实现（零第三方依赖）：
    ///   X25519 (RFC 7748) + HKDF-SHA256 + AES-256-GCM
    /// .NET Framework 4.8 没有原生 AesGcm / Curve25519，这里用 BigInteger 与 AES-ECB 自行实现。
    /// </summary>
    internal static class CryptoPrimitives
    {
        private static readonly BigInteger P = BigInteger.Parse("57896044618658097711785492504343953926634992332820282019728792003956564819949"); // 2^255-19
        private static readonly BigInteger A24 = 121665;

        private static BigInteger Mod(BigInteger x) { x %= P; return x.Sign < 0 ? x + P : x; }

        private static BigInteger ModPow(BigInteger b, BigInteger e, BigInteger m)
        {
            BigInteger r = BigInteger.One;
            while (e.Sign > 0)
            {
                if (!e.IsEven) r = r * b % m;
                b = b * b % m;
                e >>= 1;
            }
            return r;
        }

        private static void X25519Clamp(byte[] k)
        {
            k[0] &= 248; k[31] &= 127; k[31] |= 64;
        }

        // 小端字节 <-> BigInteger（RFC 7748 用 little-endian）
        private static BigInteger LeToBig(byte[] b)
        {
            // RFC 7748 用 little-endian；.NET BigInteger(byte[], isUnsigned, isBigEndian) 直接支持
            return new BigInteger(b); // net48 按 little-endian 有符号解释；clamp 后最高位<0x80，为正数
        }
        private static byte[] BigToLe(BigInteger x, int len)
        {
            // .NET BigInteger.ToByteArray() 默认小端；正数最高字节可能补 0x00
            byte[] be = x.ToByteArray();
            byte[] outb = new byte[len];
            int copy = Math.Min(len, be.Length);
            Array.Copy(be, outb, copy);
            return outb;
        }

        /// <summary>RFC 7748 X25519 标量乘：返回 32 字节共享密钥（小端）</summary>
        public static byte[] X25519(byte[] scalar, byte[] point)
        {
            byte[] k = (byte[])scalar.Clone();
            X25519Clamp(k);
            BigInteger kInt = LeToBig(k);
            // Montgomery ladder
            BigInteger x1 = Mod(LeToBig(point));
            BigInteger x2 = BigInteger.One, z2 = BigInteger.Zero;
            BigInteger x3 = x1, z3 = BigInteger.One;
            int swap = 0;
            for (int t = 254; t >= 0; t--)
            {
                int kt = (int)((kInt >> t) & BigInteger.One);
                swap ^= kt;
                if (swap != 0) { var t1 = x2; x2 = x3; x3 = t1; var t2 = z2; z2 = z3; z3 = t2; }
                swap = kt;
                BigInteger A = Mod(x2 + z2), AA = Mod(A * A);
                BigInteger B = Mod(x2 - z2), BB = Mod(B * B);
                BigInteger E = Mod(AA - BB);
                BigInteger C = Mod(x3 + z3), D = Mod(x3 - z3);
                BigInteger DA = Mod(D * A), CB = Mod(C * B);
                x3 = Mod((DA + CB) * (DA + CB));
                z3 = Mod(x1 * (DA - CB) * (DA - CB));
                x2 = Mod(AA * BB);
                z2 = Mod(E * (AA + A24 * E));
            }
            if (swap != 0) { var t1 = x2; x2 = x3; x3 = t1; var t2 = z2; z2 = z3; z3 = t2; }
            BigInteger inv = ModPow(z2, P - 2, P);
            return BigToLe(Mod(x2 * inv), 32);
        }

        /// <summary>生成 X25519 密钥对：返回 (private32le, public32le)</summary>
        public static void GenerateX25519(out byte[] priv, out byte[] pub)
        {
            byte[] seed = new byte[32];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(seed);
            seed[0] &= 248; seed[31] &= 127; seed[31] |= 64;
            priv = seed;
            // basepoint u = 9
            byte[] basepoint = new byte[32]; basepoint[0] = 9;
            pub = X25519(seed, basepoint);
        }

        /// <summary>HKDF-SHA256(ikm, salt, info, 32)，与 Node crypto.hkdfSync 一致</summary>
        public static byte[] HkdfSha256(byte[] ikm, byte[] salt, byte[] info)
        {
            byte[] prk;
            using (var h = new HMACSHA256(salt)) prk = h.ComputeHash(ikm);
            using (var h = new HMACSHA256(prk))
            {
                byte[] t = new byte[info.Length + 1];
                Array.Copy(info, t, info.Length); t[info.Length] = 1;
                return h.ComputeHash(t);
            }
        }

        /// <summary>AES-256-GCM 加密：返回 iv(12)||ciphertext||tag(16)</summary>
        public static byte[] AesGcmEncrypt(byte[] key, byte[] iv, byte[] aad, byte[] plaintext)
        {
            using (var aes = Aes.Create()) { aes.Key = key; aes.Mode = CipherMode.ECB; aes.Padding = PaddingMode.None;
                Func<byte[], byte[]> enc = (blk) => { using (var t = aes.CreateEncryptor()) return t.TransformFinalBlock(blk, 0, blk.Length); };
                byte[] h = enc(new byte[16]); // GHASH key
                byte[] j0 = new byte[16]; Array.Copy(iv, j0, 12); j0[15] = 1;
                byte[] ctr = (byte[])j0.Clone(); Inc32(ctr);
                byte[] ct = CtrCrypt(enc, ctr, plaintext);
                byte[] s = GHash(h, aad, ct);
                byte[] tag = Xor(s, enc(j0));
                byte[] outb = new byte[iv.Length + ct.Length + tag.Length];
                Array.Copy(iv, 0, outb, 0, iv.Length);
                Array.Copy(ct, 0, outb, iv.Length, ct.Length);
                Array.Copy(tag, 0, outb, iv.Length + ct.Length, tag.Length);
                return outb;
            }
        }

        /// <summary>AES-256-GCM 解密：输入 iv||ct||tag，失败抛异常</summary>
        public static byte[] AesGcmDecrypt(byte[] key, byte[] iv, byte[] aad, byte[] blob)
        {
            using (var aes = Aes.Create()) { aes.Key = key; aes.Mode = CipherMode.ECB; aes.Padding = PaddingMode.None;
                Func<byte[], byte[]> enc = (blk) => { using (var t = aes.CreateEncryptor()) return t.TransformFinalBlock(blk, 0, blk.Length); };
                byte[] h = enc(new byte[16]);
                byte[] j0 = new byte[16]; Array.Copy(iv, j0, 12); j0[15] = 1;
                int ctLen = blob.Length - 12 - 16;
                byte[] ct = new byte[ctLen]; Array.Copy(blob, 12, ct, 0, ctLen);
                byte[] tag = new byte[16]; Array.Copy(blob, 12 + ctLen, tag, 0, 16);
                byte[] s = GHash(h, aad, ct);
                byte[] expected = Xor(s, enc(j0));
                if (!FixedTimeEquals(tag, expected))
                    throw new CryptographicException("GCM tag 校验失败");
                byte[] ctr = (byte[])j0.Clone(); Inc32(ctr);
                return CtrCrypt(enc, ctr, ct);
            }
        }

        private static void Inc32(byte[] b) { int c = 1; for (int i = 15; i >= 12; i--) { int v = b[i] + c; b[i] = (byte)v; c = v >> 8; } }
        private static byte[] Xor(byte[] a, byte[] b) { byte[] o = new byte[a.Length]; for (int i = 0; i < a.Length; i++) o[i] = (byte)(a[i] ^ b[i]); return o; }
        private static bool FixedTimeEquals(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) diff |= a[i] ^ b[i];
            return diff == 0;
        }
        private static byte[] CtrCrypt(Func<byte[], byte[]> enc, byte[] ctr, byte[] input)
        {
            byte[] outb = new byte[input.Length];
            int off = 0;
            while (off < input.Length)
            {
                byte[] ks = enc(ctr); Inc32(ctr);
                int n = Math.Min(16, input.Length - off);
                for (int i = 0; i < n; i++) outb[off + i] = (byte)(input[off + i] ^ ks[i]);
                off += n;
            }
            return outb;
        }
        private static byte[] GHash(byte[] h, byte[] aad, byte[] ct)
        {
            byte[] y = new byte[16];
            GHashUpdate(y, h, Pad16(aad));
            GHashUpdate(y, h, Pad16(ct));
            byte[] lens = new byte[16];
            WriteUInt64BE(lens, 0, (ulong)aad.Length * 8);
            WriteUInt64BE(lens, 8, (ulong)ct.Length * 8);
            GHashUpdate(y, h, lens);
            return y;
        }
        private static void GHashUpdate(byte[] y, byte[] h, byte[] data)
        {
            for (int off = 0; off < data.Length; off += 16)
            {
                byte[] blk = new byte[16];
                Array.Copy(data, off, blk, 0, Math.Min(16, data.Length - off));
                byte[] x = Xor(y, blk);
                GfMulInto(x, h, y); // 原地写回 y
            }
        }
        private static byte[] Pad16(byte[] d) { int r = d.Length % 16; if (r == 0) return d; byte[] o = new byte[d.Length + 16 - r]; Array.Copy(d, o, d.Length); return o; }
        private static void WriteUInt64BE(byte[] b, int off, ulong v) { for (int i = 7; i >= 0; i--) { b[off + i] = (byte)v; v >>= 8; } }
        private static void GfMulInto(byte[] x, byte[] y, byte[] outb)
        {
            Array.Clear(outb, 0, 16); // 结果直接覆盖，不能叠加到调用方旧值上
            byte[] v = (byte[])y.Clone();
            for (int i = 0; i < 128; i++)
            {
                int bit = (x[i / 8] >> (7 - (i % 8))) & 1;
                if (bit != 0) for (int j = 0; j < 16; j++) outb[j] ^= v[j];
                bool lsb = (v[15] & 1) != 0;
                ShiftRight(v);
                if (lsb) v[0] ^= 0xe1;
            }
        }
        private static void ShiftRight(byte[] b) { int carry = 0; for (int i = 0; i < 16; i++) { int nc = b[i] & 1; b[i] = (byte)((b[i] >> 1) | (carry << 7)); carry = nc; } }

        public static byte[] Sha256(byte[] data) { using (var sha = SHA256.Create()) return sha.ComputeHash(data); }
    }

    /// <summary>与服务端 Channel 一致：AAD = 方向(1B)||序号(8B大端)，序号严格递增</summary>
    internal sealed class SecureChannel
    {
        private readonly byte[] _sendKey, _recvKey;
        private readonly byte _sendDir, _recvDir;
        private ulong _sendSeq = 0, _recvSeq = 0;
        public SecureChannel(byte[] sendKey, byte[] recvKey, byte dir)
        {
            _sendKey = sendKey; _recvKey = recvKey; _sendDir = dir; _recvDir = (byte)(dir == 0 ? 1 : 0);
        }
        private byte[] Aad(byte dir, ulong seq)
        {
            byte[] aad = new byte[9]; aad[0] = dir;
            for (int i = 0; i < 8; i++) aad[1 + i] = (byte)(seq >> (56 - 8 * i));
            return aad;
        }
        /// <summary>加密明文 JSON 字符串 -> {"e":"base64"} 帧字符串</summary>
        public string Seal(string plainJson)
        {
            byte[] iv = new byte[12]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(iv);
            byte[] blob = CryptoPrimitives.AesGcmEncrypt(_sendKey, iv, Aad(_sendDir, _sendSeq), Encoding.UTF8.GetBytes(plainJson));
            _sendSeq++;
            return "{\"e\":\"" + Convert.ToBase64String(blob) + "\"}";
        }
        /// <summary>解密 {"e":"..."} 帧字符串 -> 明文 JSON 字符串</summary>
        public string Open(string envelope)
        {
            // 极简解析 e 字段
            int i = envelope.IndexOf("\"e\""); if (i < 0) throw new CryptographicException("非法密文信封");
            int c = envelope.IndexOf(':', i); int q1 = envelope.IndexOf('"', c + 1); int q2 = envelope.IndexOf('"', q1 + 1);
            if (q1 < 0 || q2 < 0) throw new CryptographicException("非法密文信封");
            byte[] blob = Convert.FromBase64String(envelope.Substring(q1 + 1, q2 - q1 - 1));
            byte[] iv = new byte[12]; Array.Copy(blob, iv, 12);
            // AesGcmDecrypt 内部会拆 IV/ct/tag，这里必须传完整 blob（不要预先去掉 IV）
            byte[] plain = CryptoPrimitives.AesGcmDecrypt(_recvKey, iv, Aad(_recvDir, _recvSeq), blob);
            _recvSeq++;
            return Encoding.UTF8.GetString(plain);
        }
    }
}
