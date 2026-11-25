package com.nodechat.mobile;

import java.math.BigInteger;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import java.util.Arrays;

/** 与 server/src/secure.js 兼容：X25519 + HKDF-SHA256 + AES-256-GCM（零第三方依赖） */
public final class Secure {
    private static final BigInteger P = new BigInteger("7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFED", 16); // 2^255-19
    private static final BigInteger A24 = BigInteger.valueOf(121665);
    private static final SecureRandom RNG = new SecureRandom();

    private static BigInteger mod(BigInteger x) { x = x.mod(P); return x.signum() < 0 ? x.add(P) : x; }
    private static BigInteger modPow(BigInteger b, BigInteger e, BigInteger m) {
        BigInteger r = BigInteger.ONE;
        while (e.signum() > 0) { if (e.testBit(0)) r = r.multiply(b).mod(m); b = b.multiply(b).mod(m); e = e.shiftRight(1); }
        return r;
    }
    private static BigInteger leToBig(byte[] b) {
        // RFC 7748 little-endian -> BigInteger（反转成大端再构造正数）
        byte[] be = b.clone(); reverse(be);
        return new BigInteger(1, be);
    }
    private static byte[] bigToLe(BigInteger x, int len) {
        byte[] be = x.toByteArray(); // 大端，可能多一个 0x00
        int start = (be.length > 0 && be[0] == 0) ? 1 : 0;
        byte[] out = new byte[len];
        int n = Math.min(len, be.length - start);
        for (int i = 0; i < n; i++) out[i] = be[be.length - 1 - i]; // 反转成小端
        return out;
    }
    private static void reverse(byte[] b) { for (int i = 0, j = b.length - 1; i < j; i++, j--) { byte t = b[i]; b[i] = b[j]; b[j] = t; } }

    /** RFC 7748 X25519 标量乘 */
    public static byte[] x25519(byte[] scalar, byte[] point) {
        byte[] k = scalar.clone(); k[0] &= 248; k[31] &= 127; k[31] |= 64;
        BigInteger kInt = leToBig(k);
        BigInteger x1 = mod(leToBig(point));
        BigInteger x2 = BigInteger.ONE, z2 = BigInteger.ZERO, x3 = x1, z3 = BigInteger.ONE;
        int swap = 0;
        for (int t = 254; t >= 0; t--) {
            int kt = kInt.testBit(t) ? 1 : 0;
            swap ^= kt;
            if (swap != 0) { BigInteger a=x2;x2=x3;x3=a; a=z2;z2=z3;z3=a; }
            swap = kt;
            BigInteger A=mod(x2.add(z2)), AA=mod(A.multiply(A));
            BigInteger B=mod(x2.subtract(z2)), BB=mod(B.multiply(B));
            BigInteger E=mod(AA.subtract(BB));
            BigInteger C=mod(x3.add(z3)), D=mod(x3.subtract(z3));
            BigInteger DA=mod(D.multiply(A)), CB=mod(C.multiply(B));
            x3 = mod(DA.add(CB).multiply(DA.add(CB)));
            z3 = mod(x1.multiply(DA.subtract(CB)).multiply(DA.subtract(CB)));
            x2 = mod(AA.multiply(BB));
            z2 = mod(E.multiply(AA.add(A24.multiply(E))));
        }
        if (swap != 0) { BigInteger a=x2;x2=x3;x3=a; a=z2;z2=z3;z3=a; }
        BigInteger inv = modPow(z2, P.subtract(BigInteger.TWO), P);
        return bigToLe(mod(x2.multiply(inv)), 32);
    }
    /** 生成 X25519 密钥对：new Key(priv32, pub32) */
    public static final class Key { public final byte[] priv, pub; Key(byte[] p, byte[] u){priv=p;pub=u;} }
    public static Key generateX25519() {
        byte[] seed = new byte[32]; RNG.nextBytes(seed);
        seed[0] &= 248; seed[31] &= 127; seed[31] |= 64;
        byte[] base = new byte[32]; base[0] = 9;
        return new Key(seed, x25519(seed, base));
    }
    /** HKDF-SHA256(ikm, salt, info, 32) */
    public static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info) throws Exception {
        Mac h = Mac.getInstance("HmacSHA256"); h.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = h.doFinal(ikm);
        h = Mac.getInstance("HmacSHA256"); h.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] t = Arrays.copyOf(info, info.length + 1); t[info.length] = 1;
        return h.doFinal(t);
    }
    public static byte[] sha256(byte[] d) throws Exception { return java.security.MessageDigest.getInstance("SHA-256").digest(d); }
    private static byte[] concat(byte[] a, byte[] b) { byte[] o = new byte[a.length + b.length]; System.arraycopy(a,0,o,0,a.length); System.arraycopy(b,0,o,a.length,b.length); return o; }

    /** 与服务端 Channel 一致：AAD=方向(1B)||序号(8B大端) */
    public static final class Channel {
        private final byte[] sendKey, recvKey; private final int sendDir, recvDir;
        private long sendSeq = 0, recvSeq = 0;
        public Channel(byte[] sk, byte[] rk, int dir) { sendKey=sk; recvKey=rk; sendDir=dir; recvDir = dir==0?1:0; }
        private byte[] aad(int dir, long seq) {
            byte[] a = new byte[9]; a[0]=(byte)dir;
            for (int i=0;i<8;i++) a[1+i]=(byte)(seq >>> (56-8*i));
            return a;
        }
        /** 明文 JSON -> {"e":"base64(iv||ct||tag)"} */
        public String seal(String plainJson) throws java.io.IOException {
            try {
            byte[] iv = new byte[12]; RNG.nextBytes(iv);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(sendKey,"AES"), new GCMParameterSpec(128, iv));
            c.updateAAD(aad(sendDir, sendSeq)); sendSeq++;
            byte[] ct = c.doFinal(plainJson.getBytes("UTF-8")); // ct||tag(16)
            byte[] blob = concat(iv, ct);
            return "{\"e\":\"" + android.util.Base64.encodeToString(blob, android.util.Base64.NO_WRAP) + "\"}";
            } catch (Exception e) { throw new java.io.IOException("seal failed: " + e.getMessage()); }
        }
        /** {"e":"..."} -> 明文 JSON */
        public String open(String envelope) throws java.io.IOException {
            try {
            int q1 = envelope.indexOf('"', envelope.indexOf("\"e\"") + 3);
            int q2 = envelope.indexOf('"', q1 + 1);
            byte[] blob = android.util.Base64.decode(envelope.substring(q1+1, q2), android.util.Base64.NO_WRAP);
            byte[] iv = Arrays.copyOfRange(blob, 0, 12), ct = Arrays.copyOfRange(blob, 12, blob.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(recvKey,"AES"), new GCMParameterSpec(128, iv));
            c.updateAAD(aad(recvDir, recvSeq)); recvSeq++;
            return new String(c.doFinal(ct), "UTF-8");
            } catch (Exception e) { throw new java.io.IOException("open failed: " + e.getMessage()); }
        }
    }
}
